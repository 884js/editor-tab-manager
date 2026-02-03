use crate::editor::{EditorConfig, EDITORS};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorWindow {
    pub id: i32,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorState {
    pub is_active: bool,
    pub windows: Vec<EditorWindow>,
    pub active_index: Option<usize>,  // Index of the frontmost window after sorting
}

// Type aliases for backward compatibility
pub type VSCodeWindow = EditorWindow;
pub type VSCodeState = EditorState;

/// Build list of process names for is_active check
fn build_active_check_condition() -> String {
    let mut conditions: Vec<String> = Vec::new();
    for editor in EDITORS {
        conditions.push(format!("(frontApp is \"{}\")", editor.process_name));
        if editor.id == "vscode" {
            // VSCode has additional process name variants
            conditions.push("(frontApp is \"Electron\")".to_string());
            conditions.push("(frontApp contains \"Visual Studio Code\")".to_string());
        }
    }
    // Also include our tab manager
    conditions.push("(frontApp is \"Editor Tab Manager\")".to_string());
    conditions.push("(frontApp is \"editor-tab-manager\")".to_string());
    conditions.join(" or ")
}

/// Get editor state for a specific editor by bundle_id
pub fn get_editor_state(bundle_id: &str) -> EditorState {
    let config = crate::editor::get_editor_by_bundle_id(bundle_id);

    // If bundle_id is not found, return empty state
    let config = match config {
        Some(c) => c,
        None => return EditorState { is_active: false, windows: vec![], active_index: None },
    };

    get_editor_state_with_config(config)
}

/// Get editor state using a specific EditorConfig
pub fn get_editor_state_with_config(config: &EditorConfig) -> EditorState {
    let active_check = build_active_check_condition();

    let script = format!(r#"
        tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            set isActive to {}

            set windowsData to ""
            if exists process "{}" then
                tell process "{}"
                    set windowIndex to 1
                    repeat with w in windows
                        set windowTitle to name of w
                        if windowIndex > 1 then
                            set windowsData to windowsData & "@@@"
                        end if
                        set windowsData to windowsData & (windowIndex as text) & "|||" & windowTitle
                        set windowIndex to windowIndex + 1
                    end repeat
                end tell
            end if

            return (isActive as text) & "<SEP>" & windowsData
        end tell
    "#, active_check, config.process_name, config.process_name);

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let parts: Vec<&str> = stdout.splitn(2, "<SEP>").collect();

            let is_active = parts.first().map(|s| *s == "true").unwrap_or(false);
            let windows_data = parts.get(1).unwrap_or(&"");

            let (windows, active_index) = if windows_data.is_empty() {
                (vec![], None)
            } else {
                let mut windows_with_index: Vec<(i32, EditorWindow)> = windows_data
                    .split("@@@")
                    .filter_map(|entry| {
                        let parts: Vec<&str> = entry.split("|||").collect();
                        if parts.len() >= 2 {
                            let original_index = parts[0].parse::<i32>().unwrap_or(0);
                            let title = parts[1].to_string();

                            // Filter out temporary/transient windows
                            if title.is_empty() || title == "Untitled" {
                                return None;
                            }

                            let name = extract_project_name(&title, config);
                            Some((original_index, EditorWindow {
                                id: original_index,
                                name,
                                path: title,
                            }))
                        } else {
                            None
                        }
                    })
                    .collect();

                // Sort by name (project name) for stable ordering
                windows_with_index.sort_by(|a, b| a.1.name.cmp(&b.1.name));

                // Find the index of the frontmost window (original index 1) after sorting
                let active_idx = windows_with_index.iter()
                    .position(|(original_idx, _)| *original_idx == 1);

                let windows = windows_with_index.into_iter().map(|(idx, mut w)| {
                    w.id = idx;
                    w
                }).collect();

                (windows, active_idx)
            };

            EditorState { is_active, windows, active_index }
        }
        Err(_) => EditorState { is_active: false, windows: vec![], active_index: None },
    }
}

/// Get VSCode state (backward compatible - uses first available editor)
pub fn get_vscode_state() -> VSCodeState {
    // Try to get state from any running editor
    for editor in EDITORS {
        let state = get_editor_state_with_config(editor);
        if !state.windows.is_empty() || state.is_active {
            return state;
        }
    }
    // Default to first editor (VSCode)
    get_editor_state_with_config(&EDITORS[0])
}

/// Check if any supported editor or Tab Manager is the frontmost application
pub fn is_vscode_active() -> bool {
    let script = r#"
        tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            return frontApp
        end tell
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output();

    match output {
        Ok(output) => {
            let app_name = String::from_utf8_lossy(&output.stdout).trim().to_string();

            // Check if it's our tab manager
            if app_name == "Editor Tab Manager" || app_name == "editor-tab-manager" {
                return true;
            }

            // Check if it's any supported editor
            for editor in EDITORS {
                if app_name == editor.process_name || app_name == editor.app_name {
                    return true;
                }
                // VSCode-specific checks
                if editor.id == "vscode" {
                    if app_name == "Electron" || app_name.contains("Visual Studio Code") {
                        return true;
                    }
                }
            }
            false
        }
        Err(_) => false,
    }
}

/// Get windows for a specific editor by bundle_id
pub fn get_editor_windows(bundle_id: &str) -> Vec<EditorWindow> {
    let config = match crate::editor::get_editor_by_bundle_id(bundle_id) {
        Some(c) => c,
        None => return vec![],
    };

    get_editor_windows_with_config(config)
}

/// Get windows using a specific EditorConfig
pub fn get_editor_windows_with_config(config: &EditorConfig) -> Vec<EditorWindow> {
    let script = format!(r#"
        tell application "System Events"
            if not (exists process "{}") then
                return ""
            end if
            tell process "{}"
                set resultText to ""
                set windowIndex to 1
                repeat with w in windows
                    set windowTitle to name of w
                    if windowIndex > 1 then
                        set resultText to resultText & "@@@"
                    end if
                    set resultText to resultText & (windowIndex as text) & "|||" & windowTitle
                    set windowIndex to windowIndex + 1
                end repeat
                return resultText
            end tell
        end tell
    "#, config.process_name, config.process_name);

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                return vec![];
            }

            // Collect windows with their original AppleScript index
            let mut windows_with_index: Vec<(i32, EditorWindow)> = stdout
                .split("@@@")
                .filter_map(|entry| {
                    let parts: Vec<&str> = entry.split("|||").collect();
                    if parts.len() >= 2 {
                        let original_index = parts[0].parse::<i32>().unwrap_or(0);
                        let title = parts[1].to_string();

                        // Filter out temporary/transient windows
                        if title.is_empty() || title == "Untitled" {
                            return None;
                        }

                        // Extract project name from title
                        let name = extract_project_name(&title, config);

                        Some((original_index, EditorWindow {
                            id: original_index, // Will be updated after sorting
                            name,
                            path: title,
                        }))
                    } else {
                        None
                    }
                })
                .collect();

            // Sort by name (project name) for stable ordering
            windows_with_index.sort_by(|a, b| a.1.name.cmp(&b.1.name));

            // Keep the original AppleScript index as ID
            windows_with_index.into_iter().map(|(original_index, mut w)| {
                w.id = original_index;
                w
            }).collect()
        }
        Err(_) => vec![],
    }
}

/// Get all VSCode windows (backward compatible - uses first available editor)
pub fn get_vscode_windows() -> Vec<VSCodeWindow> {
    // Try to get windows from any running editor
    for editor in EDITORS {
        let windows = get_editor_windows_with_config(editor);
        if !windows.is_empty() {
            return windows;
        }
    }
    vec![]
}

/// Extract project name from editor window title
fn extract_project_name(title: &str, config: &EditorConfig) -> String {
    // Editor title formats:
    // "filename — folder — Visual Studio Code" (or "Cursor", etc.)
    // "folder — Visual Studio Code"
    // "Visual Studio Code"

    let parts: Vec<&str> = title.split(" — ").collect();

    match parts.len() {
        3 => parts[1].to_string(),  // filename — folder — Editor
        2 => {
            // Check if the second part is the editor name
            if parts[1].contains(config.display_name) || parts[1] == config.app_name {
                parts[0].to_string()  // folder — Editor
            } else {
                parts[1].to_string()
            }
        }
        1 => {
            // Check if it's just the editor name
            if parts[0].contains(config.display_name) || parts[0] == config.app_name {
                "New Window".to_string()
            } else {
                parts[0].to_string()
            }
        }
        _ => title.to_string(),
    }
}

/// Focus a specific editor window by index
pub fn focus_editor_window(bundle_id: &str, window_id: i32) -> Result<(), String> {
    let config = crate::editor::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    let script = format!(
        r#"
        tell application "System Events"
            tell process "{}"
                set targetWindow to window {}
                set value of attribute "AXMain" of targetWindow to true
                set frontmost to true
            end tell
        end tell
        tell application "{}" to activate
        "#,
        config.process_name, window_id, config.app_name
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Focus a specific VSCode window (backward compatible)
pub fn focus_vscode_window(window_id: i32) -> Result<(), String> {
    // Try VSCode first, then Cursor
    for editor in EDITORS {
        let windows = get_editor_windows_with_config(editor);
        if windows.iter().any(|w| w.id == window_id) {
            return focus_editor_window(editor.bundle_id, window_id);
        }
    }
    // Default to VSCode
    focus_editor_window(EDITORS[0].bundle_id, window_id)
}

/// Open a new editor window
pub fn open_new_editor(bundle_id: &str) -> Result<(), String> {
    let config = crate::editor::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    let script = format!(r#"
        tell application "{}"
            activate
        end tell
        delay 0.3
        tell application "System Events"
            tell process "{}"
                keystroke "n" using {{command down, shift down}}
            end tell
        end tell
    "#, config.app_name, config.process_name);

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Open a new VSCode window (backward compatible)
pub fn open_new_vscode() -> Result<(), String> {
    // Use the first available running editor, or default to VSCode
    for editor in EDITORS {
        let windows = get_editor_windows_with_config(editor);
        if !windows.is_empty() {
            return open_new_editor(editor.bundle_id);
        }
    }
    open_new_editor(EDITORS[0].bundle_id)
}

/// Close a specific editor window
pub fn close_editor_window(bundle_id: &str, window_id: i32) -> Result<(), String> {
    let config = crate::editor::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    let script = format!(
        r#"
        tell application "System Events"
            tell process "{}"
                set targetWindow to window {}
                -- Click the close button (first button in window)
                click button 1 of targetWindow
            end tell
        end tell
        "#,
        config.process_name, window_id
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Close a specific VSCode window (backward compatible)
pub fn close_vscode_window(window_id: i32) -> Result<(), String> {
    // Try to find which editor has this window
    for editor in EDITORS {
        let windows = get_editor_windows_with_config(editor);
        if windows.iter().any(|w| w.id == window_id) {
            return close_editor_window(editor.bundle_id, window_id);
        }
    }
    // Default to VSCode
    close_editor_window(EDITORS[0].bundle_id, window_id)
}
