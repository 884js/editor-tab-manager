use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VSCodeWindow {
    pub id: i32,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VSCodeState {
    pub is_active: bool,
    pub windows: Vec<VSCodeWindow>,
    pub active_index: Option<usize>,  // Index of the frontmost window after sorting
}

/// Get VSCode state in a single AppleScript call (optimized)
pub fn get_vscode_state() -> VSCodeState {
    let script = r#"
        tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            set isActive to (frontApp is "Code") or (frontApp is "Electron") or (frontApp contains "Visual Studio Code") or (frontApp is "VSCode Tab Manager") or (frontApp is "vscode-tab-manager")

            set windowsData to ""
            if exists process "Code" then
                tell process "Code"
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
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
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
                let mut windows_with_index: Vec<(i32, VSCodeWindow)> = windows_data
                    .split("@@@")
                    .filter_map(|entry| {
                        let parts: Vec<&str> = entry.split("|||").collect();
                        if parts.len() >= 2 {
                            let original_index = parts[0].parse::<i32>().unwrap_or(0);
                            let title = parts[1].to_string();
                            let name = extract_project_name(&title);
                            Some((original_index, VSCodeWindow {
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
                // Project name doesn't change when switching files, unlike path (window title)
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

            VSCodeState { is_active, windows, active_index }
        }
        Err(_) => VSCodeState { is_active: false, windows: vec![], active_index: None },
    }
}

/// Check if VSCode or Tab Manager is the frontmost application
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
            app_name == "Code"
                || app_name == "Electron"
                || app_name.contains("Visual Studio Code")
                || app_name == "VSCode Tab Manager"
                || app_name == "vscode-tab-manager"
        }
        Err(_) => false,
    }
}

/// Get all VSCode windows using AppleScript
pub fn get_vscode_windows() -> Vec<VSCodeWindow> {
    let script = r#"
        tell application "System Events"
            if not (exists process "Code") then
                return ""
            end if
            tell process "Code"
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
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                return vec![];
            }

            // Collect windows with their original AppleScript index
            let mut windows_with_index: Vec<(i32, VSCodeWindow)> = stdout
                .split("@@@")
                .filter_map(|entry| {
                    let parts: Vec<&str> = entry.split("|||").collect();
                    if parts.len() >= 2 {
                        let original_index = parts[0].parse::<i32>().unwrap_or(0);
                        let title = parts[1].to_string();

                        // Extract project name from title
                        // VSCode title format: "filename — folder — Visual Studio Code"
                        let name = extract_project_name(&title);

                        Some((original_index, VSCodeWindow {
                            id: original_index, // Will be updated after sorting
                            name,
                            path: title,
                        }))
                    } else {
                        None
                    }
                })
                .collect();

            // Sort by name (project name) for stable ordering regardless of focus state
            // Project name doesn't change when switching files, unlike path (window title)
            windows_with_index.sort_by(|a, b| a.1.name.cmp(&b.1.name));

            // Keep the original AppleScript index as ID (needed for focus_vscode_window)
            windows_with_index.into_iter().map(|(original_index, mut w)| {
                w.id = original_index;
                w
            }).collect()
        }
        Err(_) => vec![],
    }
}

/// Extract project name from VSCode window title
fn extract_project_name(title: &str) -> String {
    // VSCode title formats:
    // "filename — folder — Visual Studio Code"
    // "folder — Visual Studio Code"
    // "Visual Studio Code"

    let parts: Vec<&str> = title.split(" — ").collect();

    match parts.len() {
        3 => parts[1].to_string(),  // filename — folder — VSCode
        2 => {
            if parts[1].contains("Visual Studio Code") {
                parts[0].to_string()  // folder — VSCode
            } else {
                parts[1].to_string()
            }
        }
        1 => {
            if parts[0].contains("Visual Studio Code") {
                "New Window".to_string()
            } else {
                parts[0].to_string()
            }
        }
        _ => title.to_string(),
    }
}

/// Focus a specific VSCode window by index
pub fn focus_vscode_window(window_id: i32) -> Result<(), String> {
    let script = format!(
        r#"
        tell application "System Events"
            tell process "Code"
                set targetWindow to window {}
                set value of attribute "AXMain" of targetWindow to true
                set frontmost to true
            end tell
        end tell
        tell application "Visual Studio Code" to activate
        "#,
        window_id
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

/// Open a new VSCode window
pub fn open_new_vscode() -> Result<(), String> {
    let script = r#"
        tell application "Visual Studio Code"
            activate
        end tell
        delay 0.3
        tell application "System Events"
            tell process "Code"
                keystroke "n" using {command down, shift down}
            end tell
        end tell
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Close a specific VSCode window
pub fn close_vscode_window(window_id: i32) -> Result<(), String> {
    // Use AXPress on close button to close the window directly
    let script = format!(
        r#"
        tell application "System Events"
            tell process "Code"
                set targetWindow to window {}
                -- Click the close button (first button in window)
                click button 1 of targetWindow
            end tell
        end tell
        "#,
        window_id
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
