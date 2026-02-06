use crate::editor_config::is_supported_editor;
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::runloop::{
    kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetMain, CFRunLoopSourceRef,
};
use core_foundation::string::{CFString, CFStringRef};
use objc2_app_kit::NSWorkspace;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

// Accessibility framework types
type AXObserverRef = *mut c_void;
type AXUIElementRef = *mut c_void;
type AXObserverCallback =
    extern "C" fn(AXObserverRef, AXUIElementRef, CFStringRef, *mut c_void);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXObserverCreate(
        application: i32,
        callback: AXObserverCallback,
        observer: *mut AXObserverRef,
    ) -> i32;
    fn AXObserverGetRunLoopSource(observer: AXObserverRef) -> CFRunLoopSourceRef;
    fn AXObserverAddNotification(
        observer: AXObserverRef,
        element: AXUIElementRef,
        notification: CFStringRef,
        refcon: *mut c_void,
    ) -> i32;
    fn AXObserverRemoveNotification(
        observer: AXObserverRef,
        element: AXUIElementRef,
        notification: CFStringRef,
    ) -> i32;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
}

// kAXFocusedWindowChangedNotification constant
const K_AX_FOCUSED_WINDOW_CHANGED: &str = "AXFocusedWindowChanged";

// Error codes
const K_AX_ERROR_SUCCESS: i32 = 0;

// Wrapper types that implement Send + Sync for raw pointers
// These are safe because we only access them from the main thread (via CFRunLoop)
struct SendablePtr(*mut c_void);
unsafe impl Send for SendablePtr {}
unsafe impl Sync for SendablePtr {}

impl SendablePtr {
    fn new(ptr: *mut c_void) -> Self {
        SendablePtr(ptr)
    }

    fn get(&self) -> *mut c_void {
        self.0
    }
}

/// State for a registered editor observer
struct EditorObserver {
    observer: SendablePtr,
    app_element: SendablePtr,
    #[allow(dead_code)]
    pid: i32,
}

impl Drop for EditorObserver {
    fn drop(&mut self) {
        unsafe {
            // Remove notification before releasing
            let notification = CFString::new(K_AX_FOCUSED_WINDOW_CHANGED);
            AXObserverRemoveNotification(
                self.observer.get(),
                self.app_element.get(),
                notification.as_concrete_TypeRef(),
            );
            // Release resources
            CFRelease(self.observer.get() as *const c_void);
            CFRelease(self.app_element.get() as *const c_void);
        }
    }
}

/// Global state for AX observers
struct AXObserverState {
    observers: HashMap<i32, EditorObserver>, // pid -> observer
    app_handle: Option<AppHandle>,
}

lazy_static::lazy_static! {
    static ref AX_STATE: Mutex<AXObserverState> = Mutex::new(AXObserverState {
        observers: HashMap::new(),
        app_handle: None,
    });
    static ref CALLBACK_REFCON: Arc<Mutex<Option<AppHandle>>> = Arc::new(Mutex::new(None));
}

/// Callback when focused window changes
extern "C" fn ax_observer_callback(
    _observer: AXObserverRef,
    _element: AXUIElementRef,
    _notification: CFStringRef,
    _refcon: *mut c_void,
) {
    // Get app handle from global state
    if let Some(app_handle) = CALLBACK_REFCON.lock().unwrap().as_ref() {
        if let Some(window) = app_handle.get_webview_window("main") {
            // Emit window-focus-changed event
            let _ = window.emit("window-focus-changed", ());
        }
    }
}

/// Initialize AX observer system
pub fn init(app_handle: AppHandle) {
    *CALLBACK_REFCON.lock().unwrap() = Some(app_handle.clone());
    let mut state = AX_STATE.lock().unwrap();
    state.app_handle = Some(app_handle);
}

/// Register AX observer for an editor process
pub fn register_for_editor(bundle_id: &str) {
    // Find the running editor process
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();

    for app in apps {
        if let Some(bid) = app.bundleIdentifier() {
            if bid.to_string() == bundle_id {
                let pid = app.processIdentifier();
                register_for_pid(pid);
                break;
            }
        }
    }
}

/// Register AX observer for a specific PID
fn register_for_pid(pid: i32) {
    let mut state = AX_STATE.lock().unwrap();

    // Check if already registered
    if state.observers.contains_key(&pid) {
        return;
    }

    unsafe {
        // Create AXUIElement for the application
        let app_element = AXUIElementCreateApplication(pid);
        if app_element.is_null() {
            eprintln!("Failed to create AXUIElement for pid {}", pid);
            return;
        }

        // Create observer
        let mut observer: AXObserverRef = ptr::null_mut();
        let result = AXObserverCreate(pid, ax_observer_callback, &mut observer);
        if result != K_AX_ERROR_SUCCESS {
            eprintln!(
                "Failed to create AXObserver for pid {}: error {}",
                pid, result
            );
            CFRelease(app_element as *const c_void);
            return;
        }

        // Add notification
        let notification = CFString::new(K_AX_FOCUSED_WINDOW_CHANGED);
        let result = AXObserverAddNotification(
            observer,
            app_element,
            notification.as_concrete_TypeRef(),
            ptr::null_mut(),
        );
        if result != K_AX_ERROR_SUCCESS {
            eprintln!(
                "Failed to add notification for pid {}: error {}",
                pid, result
            );
            CFRelease(observer as *const c_void);
            CFRelease(app_element as *const c_void);
            return;
        }

        // Add to run loop
        let run_loop_source = AXObserverGetRunLoopSource(observer);
        CFRunLoopAddSource(CFRunLoopGetMain(), run_loop_source, kCFRunLoopCommonModes);

        // Store observer
        state.observers.insert(
            pid,
            EditorObserver {
                observer: SendablePtr::new(observer),
                app_element: SendablePtr::new(app_element),
                pid,
            },
        );
    }
}

/// Unregister AX observer for an editor
#[allow(dead_code)]
pub fn unregister_for_editor(bundle_id: &str) {
    // Find the running editor process
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();

    for app in apps {
        if let Some(bid) = app.bundleIdentifier() {
            if bid.to_string() == bundle_id {
                let pid = app.processIdentifier();
                unregister_for_pid(pid);
                break;
            }
        }
    }
}

/// Unregister AX observer for a specific PID
fn unregister_for_pid(pid: i32) {
    let mut state = AX_STATE.lock().unwrap();
    // Drop will clean up resources
    state.observers.remove(&pid);
}

/// Unregister all observers
#[allow(dead_code)]
pub fn unregister_all() {
    let mut state = AX_STATE.lock().unwrap();
    state.observers.clear();
}

/// Get the PID of the frontmost supported editor
#[allow(dead_code)]
pub fn get_frontmost_editor_pid() -> Option<(i32, String)> {
    let workspace = NSWorkspace::sharedWorkspace();
    if let Some(app) = workspace.frontmostApplication() {
        if let Some(bid) = app.bundleIdentifier() {
            let bundle_id = bid.to_string();
            if is_supported_editor(&bundle_id) {
                return Some((app.processIdentifier(), bundle_id));
            }
        }
    }
    None
}
