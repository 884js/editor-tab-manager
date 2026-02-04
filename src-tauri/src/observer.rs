use crate::editor_config::is_supported_editor;
use objc2::rc::Retained;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSNotification, NSNotificationName, NSOperationQueue};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

static OBSERVER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Check if the given app is a supported editor (VSCode, Cursor, etc)
fn is_target_app(app: &NSRunningApplication) -> bool {
    if let Some(bundle_id) = app.bundleIdentifier() {
        return is_supported_editor(&bundle_id.to_string());
    }
    false
}

/// Check if the given app is our tab manager
fn is_tab_manager(app: &NSRunningApplication, our_pid: i32) -> bool {
    app.processIdentifier() == our_pid
}

/// Get the currently active application
fn get_frontmost_app() -> Option<Retained<NSRunningApplication>> {
    let workspace = NSWorkspace::sharedWorkspace();
    workspace.frontmostApplication()
}

/// Payload for app activation events
#[derive(Clone, serde::Serialize)]
pub struct AppActivationPayload {
    pub app_type: String, // "editor", "tab_manager", or "other"
    pub bundle_id: Option<String>,
}

/// Start the workspace observer in a background thread
pub fn start_observer(app_handle: AppHandle) {
    if OBSERVER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    let our_pid = std::process::id() as i32;
    let app_handle = Arc::new(app_handle);

    thread::spawn(move || {
        let workspace = NSWorkspace::sharedWorkspace();
        let notification_center = workspace.notificationCenter();

        let notification_name =
            NSNotificationName::from_str("NSWorkspaceDidActivateApplicationNotification");

        let app_handle_clone = Arc::clone(&app_handle);

        let block = block2::RcBlock::new(move |_notification: NonNull<NSNotification>| {
            // Use frontmostApplication() instead of userInfo for Hardened Runtime compatibility
            let workspace = NSWorkspace::sharedWorkspace();
            let Some(app) = workspace.frontmostApplication() else {
                return;
            };

            let bundle_id_str = app.bundleIdentifier().map(|s| s.to_string());

            let payload = if is_tab_manager(&app, our_pid) {
                AppActivationPayload {
                    app_type: "tab_manager".to_string(),
                    bundle_id: None,
                }
            } else if is_target_app(&app) {
                AppActivationPayload {
                    app_type: "editor".to_string(),
                    bundle_id: bundle_id_str,
                }
            } else {
                AppActivationPayload {
                    app_type: "other".to_string(),
                    bundle_id: bundle_id_str,
                }
            };

            if let Some(window) = app_handle_clone.get_webview_window("main") {
                let _ = window.emit("app-activated", payload);
            }
        });

        let main_queue = NSOperationQueue::mainQueue();

        unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(&notification_name),
                None,
                Some(&main_queue),
                &block,
            );
        }

        // Send initial state with a small delay to ensure frontend listener is ready
        thread::sleep(std::time::Duration::from_millis(500));
        if let Some(frontmost) = get_frontmost_app() {
            let bundle_id_str = frontmost.bundleIdentifier().map(|s| s.to_string());

            let payload = if is_tab_manager(&frontmost, our_pid) {
                AppActivationPayload {
                    app_type: "tab_manager".to_string(),
                    bundle_id: None,
                }
            } else if is_target_app(&frontmost) {
                AppActivationPayload {
                    app_type: "editor".to_string(),
                    bundle_id: bundle_id_str,
                }
            } else {
                AppActivationPayload {
                    app_type: "other".to_string(),
                    bundle_id: bundle_id_str,
                }
            };

            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("app-activated", payload);
            }
        }

        // Keep the thread alive
        while OBSERVER_RUNNING.load(Ordering::SeqCst) {
            thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}

/// Stop the workspace observer
#[allow(dead_code)]
pub fn stop_observer() {
    OBSERVER_RUNNING.store(false, Ordering::SeqCst);
}
