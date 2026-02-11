use crate::ax_observer;
use crate::editor_config::is_supported_editor;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSRunningApplication, NSScreen, NSWorkspace};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNotificationName, NSOperationQueue,
};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static OBSERVER_RUNNING: AtomicBool = AtomicBool::new(false);

static DEBOUNCE_VERSION: AtomicU64 = AtomicU64::new(0);
const DEBOUNCE_DELAY_MS: u64 = 150;

static DISPLAY_DEBOUNCE_VERSION: AtomicU64 = AtomicU64::new(0);
const DISPLAY_DEBOUNCE_DELAY_MS: u64 = 300;

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

/// Payload for app activation events
#[derive(Clone, serde::Serialize, Debug)]
pub struct AppActivationPayload {
    pub app_type: String, // "editor", "tab_manager", or "other"
    pub bundle_id: Option<String>,
    pub is_on_primary_screen: bool,
}

/// NSScreen::mainScreen() はフォーカス中ウィンドウのスクリーンを返す。
/// プライマリスクリーンの origin は常に (0, 0)。
fn is_focused_on_primary_screen() -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return true; // フォールバック：プライマリと仮定
    };
    let Some(main_screen) = NSScreen::mainScreen(mtm) else {
        return true;
    };
    let origin = main_screen.frame().origin;
    origin.x.abs() < 1.0 && origin.y.abs() < 1.0
}

/// Cancel any pending "other" event by incrementing the version
fn cancel_pending_other_event() {
    DEBOUNCE_VERSION.fetch_add(1, Ordering::SeqCst);
}

/// Schedule an "other" event to be emitted after the debounce delay
fn schedule_other_event(bundle_id: Option<String>, app_handle: Arc<AppHandle>) {
    let version = DEBOUNCE_VERSION.fetch_add(1, Ordering::SeqCst) + 1;

    let app_handle_for_thread = Arc::clone(&app_handle);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(DEBOUNCE_DELAY_MS));

        if DEBOUNCE_VERSION.load(Ordering::SeqCst) != version {
            return;
        }

        let app_handle_main = Arc::clone(&app_handle_for_thread);
        let _ = app_handle_for_thread.run_on_main_thread(move || {
            let payload = AppActivationPayload {
                app_type: "other".to_string(),
                bundle_id,
                is_on_primary_screen: is_focused_on_primary_screen(),
            };
            if let Some(window) = app_handle_main.get_webview_window("main") {
                let _ = window.emit("app-activated", payload);
            }
        });
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
                    is_on_primary_screen: true,
                };
                if let Some(window) = app_handle_clone.get_webview_window("main") {
                    let _ = window.emit("app-activated", payload);
                }
            } else if is_target_app(&app) {
                // Editor is active → cancel pending "other" and emit immediately
                cancel_pending_other_event();
                ax_observer::register_for_editor(bundle_id_str.as_deref().unwrap_or_default());
                let payload = AppActivationPayload {
                    app_type: "editor".to_string(),
                    bundle_id: bundle_id_str,
                    is_on_primary_screen: true,
                };
                if let Some(window) = app_handle_clone.get_webview_window("main") {
                    let _ = window.emit("app-activated", payload);
                }
            } else {
                // Other app is active → schedule debounced emit
                schedule_other_event(bundle_id_str, Arc::clone(&app_handle_clone));
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

        // Register for display configuration change notifications
        // NSApplicationDidChangeScreenParametersNotification fires when:
        // - External monitor connected/disconnected
        // - Resolution changed
        // - Clamshell mode toggled
        let display_notification_name =
            NSNotificationName::from_str("NSApplicationDidChangeScreenParametersNotification");

        let app_handle_for_display = Arc::clone(&app_handle);
        let display_block =
            block2::RcBlock::new(move |_notification: NonNull<NSNotification>| {
                let version =
                    DISPLAY_DEBOUNCE_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
                let app_handle_debounce = Arc::clone(&app_handle_for_display);
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(DISPLAY_DEBOUNCE_DELAY_MS));
                    if DISPLAY_DEBOUNCE_VERSION.load(Ordering::SeqCst) != version {
                        return;
                    }
                    let app_handle_main = Arc::clone(&app_handle_debounce);
                    let _ = app_handle_debounce.run_on_main_thread(move || {
                        if let Some(window) = app_handle_main.get_webview_window("main") {
                            let _ = window.emit("display-changed", ());
                        }
                    });
                });
            });

        let default_center = NSNotificationCenter::defaultCenter();
        unsafe {
            default_center.addObserverForName_object_queue_usingBlock(
                Some(&display_notification_name),
                None,
                Some(&main_queue),
                &display_block,
            );
        }

        // Send initial state with a small delay to ensure frontend listener is ready
        thread::sleep(std::time::Duration::from_millis(500));
        let workspace = NSWorkspace::sharedWorkspace();
        if let Some(frontmost) = workspace.frontmostApplication() {
            let bundle_id_str = frontmost.bundleIdentifier().map(|s| s.to_string());

            let payload = if is_tab_manager(&frontmost, our_pid) {
                AppActivationPayload {
                    app_type: "tab_manager".to_string(),
                    bundle_id: None,
                    is_on_primary_screen: true,
                }
            } else if is_target_app(&frontmost) {
                AppActivationPayload {
                    app_type: "editor".to_string(),
                    bundle_id: bundle_id_str,
                    is_on_primary_screen: true,
                }
            } else {
                AppActivationPayload {
                    app_type: "other".to_string(),
                    bundle_id: bundle_id_str,
                    is_on_primary_screen: is_focused_on_primary_screen(),
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
