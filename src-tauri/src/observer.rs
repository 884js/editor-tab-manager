use crate::ax_observer;
use crate::editor_config::is_supported_editor;
use objc2::rc::Retained;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSNotification, NSNotificationName, NSOperationQueue};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

static OBSERVER_RUNNING: AtomicBool = AtomicBool::new(false);

// Debounce state for "other" events
// Using Option<(Instant, AppActivationPayload)> to track pending "other" events
static PENDING_OTHER_EVENT: Mutex<Option<(Instant, AppActivationPayload)>> = Mutex::new(None);
// Counter to invalidate pending events when editor/tab_manager is activated
static EVENT_COUNTER: AtomicU64 = AtomicU64::new(0);
const DEBOUNCE_DELAY_MS: u64 = 150;

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
#[derive(Clone, serde::Serialize, Debug)]
pub struct AppActivationPayload {
    pub app_type: String, // "editor", "tab_manager", or "other"
    pub bundle_id: Option<String>,
}

/// Cancel any pending "other" event and increment the counter
fn cancel_pending_other_event() {
    *PENDING_OTHER_EVENT.lock().unwrap() = None;
    EVENT_COUNTER.fetch_add(1, Ordering::SeqCst);
}

/// Schedule an "other" event to be emitted after the debounce delay
fn schedule_other_event(payload: AppActivationPayload, app_handle: Arc<AppHandle>) {
    let event_id = EVENT_COUNTER.load(Ordering::SeqCst);
    *PENDING_OTHER_EVENT.lock().unwrap() = Some((Instant::now(), payload.clone()));

    let app_handle_for_thread = Arc::clone(&app_handle);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(DEBOUNCE_DELAY_MS));

        // Check if this event is still valid (not cancelled)
        let current_event_id = EVENT_COUNTER.load(Ordering::SeqCst);
        if current_event_id != event_id {
            // Event was cancelled by a newer editor/tab_manager activation
            return;
        }

        // Check if the pending event still exists and has the same timestamp
        let pending = PENDING_OTHER_EVENT.lock().unwrap().take();
        if let Some((timestamp, pending_payload)) = pending {
            if timestamp.elapsed() >= Duration::from_millis(DEBOUNCE_DELAY_MS) {
                // Emit the debounced "other" event
                if let Some(window) = app_handle_for_thread.get_webview_window("main") {
                    let _ = window.emit("app-activated", pending_payload);
                }
            }
        }
    });
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

            if is_tab_manager(&app, our_pid) {
                // Tab manager is active → cancel pending "other" and emit immediately
                cancel_pending_other_event();
                let payload = AppActivationPayload {
                    app_type: "tab_manager".to_string(),
                    bundle_id: None,
                };
                if let Some(window) = app_handle_clone.get_webview_window("main") {
                    let _ = window.emit("app-activated", payload);
                }
            } else if is_target_app(&app) {
                // Editor is active → cancel pending "other" and emit immediately
                cancel_pending_other_event();
                let bundle_id = bundle_id_str.clone().unwrap_or_default();
                // Register AX observer for this editor
                ax_observer::register_for_editor(&bundle_id);
                let payload = AppActivationPayload {
                    app_type: "editor".to_string(),
                    bundle_id: bundle_id_str,
                };
                if let Some(window) = app_handle_clone.get_webview_window("main") {
                    let _ = window.emit("app-activated", payload);
                }
            } else {
                // Other app is active → schedule debounced emit
                let payload = AppActivationPayload {
                    app_type: "other".to_string(),
                    bundle_id: bundle_id_str,
                };
                schedule_other_event(payload, Arc::clone(&app_handle_clone));
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
