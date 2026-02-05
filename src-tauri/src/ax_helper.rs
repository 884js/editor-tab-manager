//! Accessibility API helper module for macOS window management
//!
//! Provides fast, direct access to window information using the macOS Accessibility API
//! instead of slower AppleScript calls.

use accessibility::{AXUIElement, AXUIElementActions, AXUIElementAttributes};
use core_foundation::boolean::CFBoolean;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::NSString;

/// Get the process ID (PID) for an application by its bundle identifier
pub fn get_pid_by_bundle_id(bundle_id: &str) -> Option<i32> {
    let bundle_id_ns = NSString::from_str(bundle_id);
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_id_ns);

    if apps.count() > 0 {
        let app = apps.objectAtIndex(0);
        let pid = app.processIdentifier();
        if pid > 0 {
            return Some(pid);
        }
    }
    None
}

/// Get all windows for an application by PID
/// Returns a vector of (window_title, is_frontmost) tuples
pub fn get_windows_ax(pid: i32) -> Result<Vec<(String, bool)>, String> {
    let app = AXUIElement::application(pid);

    // Get windows attribute
    let windows = app
        .windows()
        .map_err(|e| format!("Failed to get windows: {:?}", e))?;

    // Get the focused window to determine which is active
    let focused_window: Option<AXUIElement> = app.focused_window().ok();

    let mut result = Vec::new();

    for window in windows.into_iter() {
        // Filter: only include actual windows (role="AXWindow")
        // This filters out AXApplication elements that Electron apps
        // sometimes return after sleep/wake cycles
        let role = window.role().ok().map(|s| s.to_string());
        if role.as_deref() != Some("AXWindow") {
            continue;
        }

        // Get window title
        let title = window
            .title()
            .map(|s| s.to_string())
            .unwrap_or_default();

        // Check if this window is the focused one
        let is_frontmost = focused_window
            .as_ref()
            .map(|fw| windows_equal(&window, fw))
            .unwrap_or(false);

        result.push((title, is_frontmost));
    }

    Ok(result)
}

/// Focus a specific window by index (0-based)
pub fn focus_window_ax(pid: i32, window_index: usize) -> Result<(), String> {
    let app = AXUIElement::application(pid);

    // Get windows and filter to only include actual windows (role="AXWindow")
    let windows = app
        .windows()
        .map_err(|e| format!("Failed to get windows: {:?}", e))?;

    let windows_vec: Vec<_> = windows
        .into_iter()
        .filter(|w| w.role().ok().map(|s| s.to_string()).as_deref() == Some("AXWindow"))
        .collect();

    if window_index >= windows_vec.len() {
        return Err(format!(
            "Window index {} out of bounds (total: {})",
            window_index,
            windows_vec.len()
        ));
    }

    let window = &windows_vec[window_index];

    // Raise the window (bring to front)
    window
        .raise()
        .map_err(|e| format!("Failed to raise window: {:?}", e))?;

    // Set as main window
    window
        .set_main(CFBoolean::true_value())
        .map_err(|e| format!("Failed to set main window: {:?}", e))?;

    // Activate the application
    activate_app_by_pid(pid)?;

    Ok(())
}

/// Close a specific window by index (0-based)
pub fn close_window_ax(pid: i32, window_index: usize) -> Result<(), String> {
    let app = AXUIElement::application(pid);

    // Get windows and filter to only include actual windows (role="AXWindow")
    let windows = app
        .windows()
        .map_err(|e| format!("Failed to get windows: {:?}", e))?;

    let windows_vec: Vec<_> = windows
        .into_iter()
        .filter(|w| w.role().ok().map(|s| s.to_string()).as_deref() == Some("AXWindow"))
        .collect();

    if window_index >= windows_vec.len() {
        return Err(format!(
            "Window index {} out of bounds (total: {})",
            window_index,
            windows_vec.len()
        ));
    }

    let window = &windows_vec[window_index];

    // Get the close button - AXCloseButton returns an AXUIElement
    let close_button = get_close_button(window)?;

    close_button
        .press()
        .map_err(|e| format!("Failed to press close button: {:?}", e))?;

    Ok(())
}

/// Get the close button from a window element
fn get_close_button(window: &AXUIElement) -> Result<AXUIElement, String> {
    use accessibility_sys::AXUIElementCopyAttributeValue;
    use core_foundation::base::CFType;

    unsafe {
        let attr_name = CFString::from_static_string("AXCloseButton");
        let mut result: core_foundation::base::CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            &mut result,
        );

        if err != 0 {
            return Err(format!("Failed to get close button: AXError {}", err));
        }

        if result.is_null() {
            return Err("Close button not found".to_string());
        }

        // Convert CFTypeRef to AXUIElement
        let cf_type = CFType::wrap_under_create_rule(result);
        let ax_element = AXUIElement::wrap_under_get_rule(
            cf_type.as_concrete_TypeRef() as accessibility_sys::AXUIElementRef
        );
        Ok(ax_element)
    }
}

/// Open a new window in the application
/// Uses keyboard shortcut Cmd+Shift+N via osascript
pub fn open_new_window_ax(pid: i32) -> Result<(), String> {
    // First activate the app
    activate_app_by_pid(pid)?;

    // Small delay to ensure app is active
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Send Cmd+Shift+N keyboard shortcut using osascript
    send_keyboard_shortcut("n", true, true)?;

    Ok(())
}

/// Activate an application by its PID
fn activate_app_by_pid(pid: i32) -> Result<(), String> {
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        #[allow(deprecated)]
        let _ = app.activateWithOptions(
            objc2_app_kit::NSApplicationActivationOptions::ActivateIgnoringOtherApps,
        );
        return Ok(());
    }

    Err(format!("Could not find application with PID {}", pid))
}

/// Check if any supported editor or the Tab Manager is the frontmost application
pub fn is_editor_frontmost(editor_bundle_ids: &[&str]) -> bool {
    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    if let Some(frontmost) = workspace.frontmostApplication() {
        if let Some(bundle_id) = frontmost.bundleIdentifier() {
            let bundle_str = bundle_id.to_string();

            // Check if it's our tab manager
            if bundle_str == "com.884js.editor-tab-manager" {
                return true;
            }

            // Check if it's any supported editor
            for editor_bundle in editor_bundle_ids {
                if bundle_str == *editor_bundle {
                    return true;
                }
            }
        }
    }
    false
}

/// Send a keyboard shortcut using osascript
fn send_keyboard_shortcut(key: &str, cmd: bool, shift: bool) -> Result<(), String> {
    use std::process::Command;

    let mut modifiers = Vec::new();
    if cmd {
        modifiers.push("command down");
    }
    if shift {
        modifiers.push("shift down");
    }

    let modifier_str = if modifiers.is_empty() {
        String::new()
    } else {
        format!(" using {{{}}}", modifiers.join(", "))
    };

    let script = format!(
        r#"tell application "System Events" to keystroke "{}"{}"#,
        key, modifier_str
    );

    Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to send keystroke: {}", e))?;

    Ok(())
}

/// Compare two AXUIElements for equality by comparing their window titles
fn windows_equal(a: &AXUIElement, b: &AXUIElement) -> bool {
    let title_a = a.title();
    let title_b = b.title();

    match (title_a, title_b) {
        (Ok(ta), Ok(tb)) => ta == tb,
        _ => false,
    }
}
