use crate::ax_observer;
use crate::editor_config::is_supported_editor;
use crate::notification;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSRunningApplication, NSScreen, NSWorkspace};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNotificationName, NSOperationQueue, NSString,
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
    pub covers_editor: bool,
}

/// Get PIDs of all running supported editors.
fn get_running_editor_pids() -> Vec<i32> {
    let workspace = NSWorkspace::sharedWorkspace();
    let running_apps = workspace.runningApplications();
    running_apps
        .iter()
        .filter_map(|app| {
            let bid = app.bundleIdentifier()?;
            if is_supported_editor(&bid.to_string()) {
                Some(app.processIdentifier())
            } else {
                None
            }
        })
        .collect()
}

/// Get the maximum window width among all running editors.
/// Returns None if no editors are running or no editor windows exist.
fn get_max_editor_window_width() -> Option<f64> {
    get_running_editor_pids()
        .iter()
        .filter_map(|&pid| crate::ax_helper::get_largest_window_size(pid))
        .map(|(w, _)| w)
        .reduce(f64::max)
}

/// Check if the frontmost window covers the editor windows.
/// Returns Some(true) if front window >= editor window width (editor hidden → hide tab bar),
/// Some(false) if front window < editor window width (editor visible → show tab bar),
/// or None if front app has no windows yet (cold start).
fn is_front_covering_editor(front_pid: i32) -> Option<bool> {
    let (front_width, _) = crate::ax_helper::get_largest_window_size(front_pid)?;

    match get_max_editor_window_width() {
        Some(editor_width) => Some(front_width >= editor_width),
        None => Some(true), // No editor running → hide tab bar
    }
}

const COLD_START_RETRY_COUNT: u32 = 4;
const COLD_START_RETRY_INTERVAL_MS: u64 = 500;

/// Re-check window size for a cold-starting app.
/// Called when the initial check found no windows (app still launching).
/// If the new window covers the editor, re-emits app-activated to hide the tab bar.
fn schedule_cold_start_recheck(
    pid: i32,
    bundle_id: Option<String>,
    app_handle: Arc<AppHandle>,
    debounce_version: u64,
) {
    thread::spawn(move || {
        for _ in 0..COLD_START_RETRY_COUNT {
            thread::sleep(Duration::from_millis(COLD_START_RETRY_INTERVAL_MS));

            if DEBOUNCE_VERSION.load(Ordering::SeqCst) != debounce_version {
                return; // User switched to another app
            }

            // AX API is thread-safe, check from background thread
            match is_front_covering_editor(pid) {
                Some(true) => {
                    // Window covers the editor → hide tab bar
                    let bid = bundle_id;
                    let app_handle_main = Arc::clone(&app_handle);
                    let _ = app_handle.run_on_main_thread(move || {
                        let payload = AppActivationPayload {
                            app_type: "other".to_string(),
                            bundle_id: bid,
                            is_on_primary_screen: is_focused_on_primary_screen(),
                            covers_editor: true,
                        };
                        emit_app_activated(&app_handle_main, payload);
                    });
                    return;
                }
                Some(false) => {
                    // Window doesn't cover editor → tab bar already visible
                    return;
                }
                None => {
                    // No windows yet → continue retrying
                }
            }
        }
    });
}

/// Emit an app-activated event to the main window.
fn emit_app_activated(app_handle: &AppHandle, payload: AppActivationPayload) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit("app-activated", payload);
    }
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

/// Cancel any pending "other" event by incrementing the debounce version.
/// Called from ax_observer when editor activation is confirmed via AX events.
pub fn cancel_pending_other_event() {
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
        let app_handle_retry = Arc::clone(&app_handle_for_thread);
        let _ = app_handle_for_thread.run_on_main_thread(move || {
            // Re-check frontmostApplication after debounce.
            // The app may have changed during the delay (e.g., editor became active).
            let workspace = NSWorkspace::sharedWorkspace();
            if let Some(frontmost) = workspace.frontmostApplication() {
                if is_target_app(&frontmost) {
                    let bid = frontmost.bundleIdentifier().map(|s| s.to_string());
                    notification::remove_all_delivered_notifications();
                    ax_observer::register_all_editors();
                    let payload = AppActivationPayload {
                        app_type: "editor".to_string(),
                        bundle_id: bid,
                        is_on_primary_screen: true,
                        covers_editor: false,
                    };
                    emit_app_activated(&app_handle_main, payload);
                    return;
                }

                // Check if the other app's window covers the editor
                let pid = frontmost.processIdentifier();
                match is_front_covering_editor(pid) {
                    Some(large) => {
                        let payload = AppActivationPayload {
                            app_type: "other".to_string(),
                            bundle_id,
                            is_on_primary_screen: is_focused_on_primary_screen(),
                            covers_editor: large,
                        };
                        emit_app_activated(&app_handle_main, payload);
                    }
                    None => {
                        // Cold start: app has no windows yet.
                        // Show tab bar initially, then recheck after window appears.
                        let bid_retry = bundle_id.clone();
                        let payload = AppActivationPayload {
                            app_type: "other".to_string(),
                            bundle_id,
                            is_on_primary_screen: is_focused_on_primary_screen(),
                            covers_editor: false,
                        };
                        emit_app_activated(&app_handle_main, payload);
                        schedule_cold_start_recheck(
                            pid,
                            bid_retry,
                            app_handle_retry,
                            version,
                        );
                    }
                }
            } else {
                let payload = AppActivationPayload {
                    app_type: "other".to_string(),
                    bundle_id,
                    is_on_primary_screen: is_focused_on_primary_screen(),
                    covers_editor: true,
                };
                emit_app_activated(&app_handle_main, payload);
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

        let block = block2::RcBlock::new(move |notification: NonNull<NSNotification>| {
            // Approach 1: Try to get the activated app from notification's userInfo.
            // NSWorkspaceDidActivateApplicationNotification provides the app via
            // NSWorkspaceApplicationKey. This is more accurate than frontmostApplication()
            // for Dock-click scenarios where the frontmost app hasn't updated yet.
            let app_info: Option<(Option<String>, i32)> = unsafe {
                let notif = notification.as_ref();
                notif.userInfo().and_then(|info| {
                    let key = NSString::from_str("NSWorkspaceApplicationKey");
                    info.objectForKey(&*key).map(|obj| {
                        let app = &*(&*obj as *const _ as *const NSRunningApplication);
                        (
                            app.bundleIdentifier().map(|s| s.to_string()),
                            app.processIdentifier(),
                        )
                    })
                })
            };

            // Fallback to frontmostApplication() if userInfo extraction failed
            let (bundle_id_str, app_pid) = match app_info {
                Some(info) => info,
                None => {
                    let workspace = NSWorkspace::sharedWorkspace();
                    let Some(app) = workspace.frontmostApplication() else {
                        return;
                    };
                    (
                        app.bundleIdentifier().map(|s| s.to_string()),
                        app.processIdentifier(),
                    )
                }
            };

            if app_pid == our_pid {
                // Tab manager is active → cancel pending "other" and emit immediately
                cancel_pending_other_event();
                let payload = AppActivationPayload {
                    app_type: "tab_manager".to_string(),
                    bundle_id: None,
                    is_on_primary_screen: true,
                    covers_editor: false,
                };
                emit_app_activated(&app_handle_clone, payload);
            } else if bundle_id_str
                .as_ref()
                .is_some_and(|bid| is_supported_editor(bid))
            {
                // Editor is active → cancel pending "other" and emit immediately
                cancel_pending_other_event();
                notification::remove_all_delivered_notifications();
                ax_observer::register_all_editors();
                let payload = AppActivationPayload {
                    app_type: "editor".to_string(),
                    bundle_id: bundle_id_str,
                    is_on_primary_screen: true,
                    covers_editor: false,
                };
                emit_app_activated(&app_handle_clone, payload);
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
                    covers_editor: false,
                }
            } else if is_target_app(&frontmost) {
                AppActivationPayload {
                    app_type: "editor".to_string(),
                    bundle_id: bundle_id_str,
                    is_on_primary_screen: true,
                    covers_editor: false,
                }
            } else {
                AppActivationPayload {
                    app_type: "other".to_string(),
                    bundle_id: bundle_id_str,
                    is_on_primary_screen: is_focused_on_primary_screen(),
                    covers_editor: true, // default: hide for initial state
                }
            };

            emit_app_activated(&app_handle, payload);
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
