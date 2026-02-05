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

/// Get window frame (position and size) by PID and window index
/// Returns (x, y, width, height)
#[allow(dead_code)]
pub fn get_window_frame(pid: i32, window_index: usize) -> Result<(f64, f64, f64, f64), String> {
    use accessibility_sys::AXUIElementCopyAttributeValue;
    use core_foundation::base::CFType;

    let app = AXUIElement::application(pid);

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

    // Get position (AXPosition)
    let (x, y) = unsafe {
        let attr_name = CFString::from_static_string("AXPosition");
        let mut result: core_foundation::base::CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            &mut result,
        );

        if err != 0 || result.is_null() {
            return Err(format!("Failed to get window position: AXError {}", err));
        }

        let cf_type = CFType::wrap_under_create_rule(result);
        ax_value_to_point(cf_type.as_concrete_TypeRef())?
    };

    // Get size (AXSize)
    let (width, height) = unsafe {
        let attr_name = CFString::from_static_string("AXSize");
        let mut result: core_foundation::base::CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            &mut result,
        );

        if err != 0 || result.is_null() {
            return Err(format!("Failed to get window size: AXError {}", err));
        }

        let cf_type = CFType::wrap_under_create_rule(result);
        ax_value_to_size(cf_type.as_concrete_TypeRef())?
    };

    Ok((x, y, width, height))
}

/// Set window frame (position and size) by PID and window index
#[allow(dead_code)]
pub fn set_window_frame(
    pid: i32,
    window_index: usize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use accessibility_sys::AXUIElementSetAttributeValue;
    use core_foundation::base::CFRelease;

    let app = AXUIElement::application(pid);

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

    // Set position (AXPosition)
    unsafe {
        let attr_name = CFString::from_static_string("AXPosition");
        let point_value = point_to_ax_value(x, y)?;

        let err = AXUIElementSetAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            point_value,
        );

        // Release the CFTypeRef after use
        CFRelease(point_value);

        if err != 0 {
            return Err(format!("Failed to set window position: AXError {}", err));
        }
    };

    // Set size (AXSize)
    unsafe {
        let attr_name = CFString::from_static_string("AXSize");
        let size_value = size_to_ax_value(width, height)?;

        let err = AXUIElementSetAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            size_value,
        );

        // Release the CFTypeRef after use
        CFRelease(size_value);

        if err != 0 {
            return Err(format!("Failed to set window size: AXError {}", err));
        }
    };

    Ok(())
}

/// Get all window frames for an application by PID
/// Returns Vec<(title, x, y, width, height)>
pub fn get_all_window_frames(pid: i32) -> Result<Vec<(String, f64, f64, f64, f64)>, String> {
    use accessibility_sys::AXUIElementCopyAttributeValue;
    use core_foundation::base::CFType;

    let app = AXUIElement::application(pid);

    let windows = app
        .windows()
        .map_err(|e| format!("Failed to get windows: {:?}", e))?;

    let mut result = Vec::new();

    for window in windows.into_iter() {
        let role = window.role().ok().map(|s| s.to_string());
        if role.as_deref() != Some("AXWindow") {
            continue;
        }

        let title = window
            .title()
            .map(|s| s.to_string())
            .unwrap_or_default();

        // Get position
        let (x, y) = unsafe {
            let attr_name = CFString::from_static_string("AXPosition");
            let mut pos_result: core_foundation::base::CFTypeRef = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(
                window.as_concrete_TypeRef(),
                attr_name.as_concrete_TypeRef(),
                &mut pos_result,
            );

            if err != 0 || pos_result.is_null() {
                continue;
            }

            let cf_type = CFType::wrap_under_create_rule(pos_result);
            match ax_value_to_point(cf_type.as_concrete_TypeRef()) {
                Ok(point) => point,
                Err(_) => continue,
            }
        };

        // Get size
        let (width, height) = unsafe {
            let attr_name = CFString::from_static_string("AXSize");
            let mut size_result: core_foundation::base::CFTypeRef = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(
                window.as_concrete_TypeRef(),
                attr_name.as_concrete_TypeRef(),
                &mut size_result,
            );

            if err != 0 || size_result.is_null() {
                continue;
            }

            let cf_type = CFType::wrap_under_create_rule(size_result);
            match ax_value_to_size(cf_type.as_concrete_TypeRef()) {
                Ok(size) => size,
                Err(_) => continue,
            }
        };

        result.push((title, x, y, width, height));
    }

    Ok(result)
}

/// Check if a window is minimized
#[allow(dead_code)]
pub fn is_window_minimized(pid: i32, window_index: usize) -> Result<bool, String> {
    use accessibility_sys::AXUIElementCopyAttributeValue;
    use core_foundation::base::CFType;

    let app = AXUIElement::application(pid);

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

    unsafe {
        let attr_name = CFString::from_static_string("AXMinimized");
        let mut result: core_foundation::base::CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            &mut result,
        );

        if err != 0 || result.is_null() {
            return Ok(false); // Assume not minimized if we can't determine
        }

        let cf_type = CFType::wrap_under_create_rule(result);
        let cf_bool = CFBoolean::wrap_under_get_rule(
            cf_type.as_concrete_TypeRef() as core_foundation::boolean::CFBooleanRef
        );
        Ok(cf_bool == CFBoolean::true_value())
    }
}

/// Check if a window is fullscreen
#[allow(dead_code)]
pub fn is_window_fullscreen(pid: i32, window_index: usize) -> Result<bool, String> {
    use accessibility_sys::AXUIElementCopyAttributeValue;
    use core_foundation::base::CFType;

    let app = AXUIElement::application(pid);

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

    // Check AXFullScreen attribute
    unsafe {
        let attr_name = CFString::from_static_string("AXFullScreen");
        let mut result: core_foundation::base::CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            &mut result,
        );

        if err != 0 || result.is_null() {
            return Ok(false); // Assume not fullscreen if we can't determine
        }

        let cf_type = CFType::wrap_under_create_rule(result);
        let cf_bool = CFBoolean::wrap_under_get_rule(
            cf_type.as_concrete_TypeRef() as core_foundation::boolean::CFBooleanRef
        );
        Ok(cf_bool == CFBoolean::true_value())
    }
}

/// Convert AXValue (CGPoint) to (x, y)
unsafe fn ax_value_to_point(value: core_foundation::base::CFTypeRef) -> Result<(f64, f64), String> {
    use core_graphics::geometry::CGPoint;

    let mut point = CGPoint::new(0.0, 0.0);
    let success = accessibility_sys::AXValueGetValue(
        value as accessibility_sys::AXValueRef,
        accessibility_sys::kAXValueTypeCGPoint,
        &mut point as *mut CGPoint as *mut std::ffi::c_void,
    );

    if success {
        Ok((point.x, point.y))
    } else {
        Err("Failed to extract CGPoint from AXValue".to_string())
    }
}

/// Convert AXValue (CGSize) to (width, height)
unsafe fn ax_value_to_size(value: core_foundation::base::CFTypeRef) -> Result<(f64, f64), String> {
    use core_graphics::geometry::CGSize;

    let mut size = CGSize::new(0.0, 0.0);
    let success = accessibility_sys::AXValueGetValue(
        value as accessibility_sys::AXValueRef,
        accessibility_sys::kAXValueTypeCGSize,
        &mut size as *mut CGSize as *mut std::ffi::c_void,
    );

    if success {
        Ok((size.width, size.height))
    } else {
        Err("Failed to extract CGSize from AXValue".to_string())
    }
}

/// Convert (x, y) to AXValue (CGPoint)
unsafe fn point_to_ax_value(x: f64, y: f64) -> Result<core_foundation::base::CFTypeRef, String> {
    use core_graphics::geometry::CGPoint;

    let point = CGPoint::new(x, y);
    let value = accessibility_sys::AXValueCreate(
        accessibility_sys::kAXValueTypeCGPoint,
        &point as *const CGPoint as *const std::ffi::c_void,
    );

    if value.is_null() {
        Err("Failed to create AXValue for CGPoint".to_string())
    } else {
        Ok(value as core_foundation::base::CFTypeRef)
    }
}

/// Convert (width, height) to AXValue (CGSize)
unsafe fn size_to_ax_value(
    width: f64,
    height: f64,
) -> Result<core_foundation::base::CFTypeRef, String> {
    use core_graphics::geometry::CGSize;

    let size = CGSize::new(width, height);
    let value = accessibility_sys::AXValueCreate(
        accessibility_sys::kAXValueTypeCGSize,
        &size as *const CGSize as *const std::ffi::c_void,
    );

    if value.is_null() {
        Err("Failed to create AXValue for CGSize".to_string())
    } else {
        Ok(value as core_foundation::base::CFTypeRef)
    }
}

/// Set window frame (position and size) by PID and window title
/// This avoids index mismatch issues by finding the window directly by title
pub fn set_window_frame_by_title(
    pid: i32,
    title: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use accessibility_sys::AXUIElementSetAttributeValue;
    use core_foundation::base::CFRelease;

    let app = AXUIElement::application(pid);

    let windows = app
        .windows()
        .map_err(|e| format!("Failed to get windows: {:?}", e))?;

    // Find the window with matching title
    let window = windows
        .into_iter()
        .find(|w| {
            // Check role is AXWindow
            let role = w.role().ok().map(|s| s.to_string());
            if role.as_deref() != Some("AXWindow") {
                return false;
            }
            // Check title matches
            let w_title = w.title().map(|s| s.to_string()).unwrap_or_default();
            w_title == title
        })
        .ok_or_else(|| format!("Window with title '{}' not found", title))?;

    // Set position (AXPosition)
    let position_result = unsafe {
        let attr_name = CFString::from_static_string("AXPosition");
        let point_value = point_to_ax_value(x, y)?;

        let err = AXUIElementSetAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            point_value,
        );

        // Release the CFTypeRef after use
        CFRelease(point_value);

        if err != 0 {
            return Err(format!("Failed to set window position: AXError {}", err));
        }
        Ok(())
    };

    if let Err(e) = position_result {
        return Err(e);
    }

    // Set size (AXSize)
    unsafe {
        let attr_name = CFString::from_static_string("AXSize");
        let size_value = size_to_ax_value(width, height)?;

        let err = AXUIElementSetAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            size_value,
        );

        // Release the CFTypeRef after use
        CFRelease(size_value);

        if err != 0 {
            return Err(format!("Failed to set window size: AXError {}", err));
        }
    };

    Ok(())
}

/// Check if a window is minimized by title
pub fn is_window_minimized_by_title(pid: i32, title: &str) -> Result<bool, String> {
    use accessibility_sys::AXUIElementCopyAttributeValue;
    use core_foundation::base::CFType;

    let app = AXUIElement::application(pid);

    let windows = app
        .windows()
        .map_err(|e| format!("Failed to get windows: {:?}", e))?;

    let window = windows
        .into_iter()
        .find(|w| {
            let role = w.role().ok().map(|s| s.to_string());
            if role.as_deref() != Some("AXWindow") {
                return false;
            }
            let w_title = w.title().map(|s| s.to_string()).unwrap_or_default();
            w_title == title
        })
        .ok_or_else(|| format!("Window with title '{}' not found", title))?;

    unsafe {
        let attr_name = CFString::from_static_string("AXMinimized");
        let mut result: core_foundation::base::CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            &mut result,
        );

        if err != 0 || result.is_null() {
            return Ok(false);
        }

        let cf_type = CFType::wrap_under_create_rule(result);
        let cf_bool = CFBoolean::wrap_under_get_rule(
            cf_type.as_concrete_TypeRef() as core_foundation::boolean::CFBooleanRef
        );
        Ok(cf_bool == CFBoolean::true_value())
    }
}

/// Check if a window is fullscreen by title
pub fn is_window_fullscreen_by_title(pid: i32, title: &str) -> Result<bool, String> {
    use accessibility_sys::AXUIElementCopyAttributeValue;
    use core_foundation::base::CFType;

    let app = AXUIElement::application(pid);

    let windows = app
        .windows()
        .map_err(|e| format!("Failed to get windows: {:?}", e))?;

    let window = windows
        .into_iter()
        .find(|w| {
            let role = w.role().ok().map(|s| s.to_string());
            if role.as_deref() != Some("AXWindow") {
                return false;
            }
            let w_title = w.title().map(|s| s.to_string()).unwrap_or_default();
            w_title == title
        })
        .ok_or_else(|| format!("Window with title '{}' not found", title))?;

    unsafe {
        let attr_name = CFString::from_static_string("AXFullScreen");
        let mut result: core_foundation::base::CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window.as_concrete_TypeRef(),
            attr_name.as_concrete_TypeRef(),
            &mut result,
        );

        if err != 0 || result.is_null() {
            return Ok(false);
        }

        let cf_type = CFType::wrap_under_create_rule(result);
        let cf_bool = CFBoolean::wrap_under_get_rule(
            cf_type.as_concrete_TypeRef() as core_foundation::boolean::CFBooleanRef
        );
        Ok(cf_bool == CFBoolean::true_value())
    }
}
