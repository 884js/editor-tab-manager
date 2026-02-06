use crate::ax_helper;
use crate::editor_config::{EditorConfig, EDITORS};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorWindow {
    pub id: u32,  // CGWindowID for reliable window identification
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorState {
    pub is_active: bool,
    pub windows: Vec<EditorWindow>,
    pub active_index: Option<usize>,
}

/// Get editor state for any running editor (tries each editor in order)
pub fn get_any_editor_state() -> EditorState {
    for editor in EDITORS {
        let state = get_editor_state_with_config(editor);
        if !state.windows.is_empty() || state.is_active {
            return state;
        }
    }
    // Default to first editor (VSCode) if none running
    get_editor_state_with_config(&EDITORS[0])
}

/// Get windows from any running editor (tries each editor in order)
pub fn get_any_editor_windows() -> Vec<EditorWindow> {
    for editor in EDITORS {
        let windows = get_editor_windows_with_config(editor);
        if !windows.is_empty() {
            return windows;
        }
    }
    vec![]
}

/// Get editor state for a specific editor by bundle_id
pub fn get_editor_state(bundle_id: &str) -> EditorState {
    let config = crate::editor_config::get_editor_by_bundle_id(bundle_id);

    let config = match config {
        Some(c) => c,
        None => return EditorState { is_active: false, windows: vec![], active_index: None },
    };

    get_editor_state_with_config(config)
}

/// Get editor state using a specific EditorConfig
pub fn get_editor_state_with_config(config: &EditorConfig) -> EditorState {
    let is_active = is_editor_active();

    let pid = match ax_helper::get_pid_by_bundle_id(config.bundle_id) {
        Some(pid) => pid,
        None => return EditorState { is_active, windows: vec![], active_index: None },
    };

    let ax_windows = match ax_helper::get_windows_ax(pid) {
        Ok(w) => w,
        Err(_) => return EditorState { is_active, windows: vec![], active_index: None },
    };

    let mut active_index: Option<usize> = None;
    let mut windows = Vec::new();

    for (window_id, title, is_frontmost) in ax_windows.iter() {
        // Filter out temporary/transient windows
        if title.is_empty() || title == "Untitled" {
            continue;
        }

        let name = extract_project_name(title, config);

        windows.push(EditorWindow {
            id: *window_id,  // Use CGWindowID for reliable identification
            name,
            path: title.clone(),
        });

        if *is_frontmost {
            active_index = Some(windows.len() - 1);
        }
    }

    EditorState { is_active, windows, active_index }
}

/// Check if any supported editor or Tab Manager is the frontmost application
pub fn is_editor_active() -> bool {
    let editor_bundle_ids: Vec<&str> = EDITORS.iter().map(|e| e.bundle_id).collect();
    ax_helper::is_editor_frontmost(&editor_bundle_ids)
}

/// Get windows for a specific editor by bundle_id
pub fn get_editor_windows(bundle_id: &str) -> Vec<EditorWindow> {
    let config = match crate::editor_config::get_editor_by_bundle_id(bundle_id) {
        Some(c) => c,
        None => return vec![],
    };

    get_editor_windows_with_config(config)
}

/// Get windows using a specific EditorConfig
pub fn get_editor_windows_with_config(config: &EditorConfig) -> Vec<EditorWindow> {
    let pid = match ax_helper::get_pid_by_bundle_id(config.bundle_id) {
        Some(pid) => pid,
        None => return vec![],
    };

    let ax_windows = match ax_helper::get_windows_ax(pid) {
        Ok(w) => w,
        Err(_) => return vec![],
    };

    ax_windows
        .iter()
        .filter_map(|(window_id, title, _)| {
            // Filter out temporary/transient windows
            if title.is_empty() || title == "Untitled" {
                return None;
            }

            let name = extract_project_name(title, config);

            Some(EditorWindow {
                id: *window_id,  // Use CGWindowID for reliable identification
                name,
                path: title.clone(),
            })
        })
        .collect()
}

/// Extract project name from editor window title
fn extract_project_name(title: &str, config: &EditorConfig) -> String {
    // Editor title formats vary by editor:
    // VSCode/Cursor: "filename — folder — Editor" or "folder — Editor" or "Editor"
    // Zed: "project — filename" or "project"

    let parts: Vec<&str> = title.split(" — ").collect();

    match config.id {
        "zed" => {
            // Zed format: "project — filename" or "project"
            match parts.len() {
                2 | 1 => parts[0].to_string(),
                _ => title.to_string(),
            }
        }
        // VSCode, Cursor, and other editors
        _ => {
            // VSCode/Cursor format:
            // "filename — folder — Editor" (3 parts)
            // "folder — Editor" (2 parts)
            // "Editor" (1 part)
            match parts.len() {
                3 => parts[1].to_string(),
                2 => {
                    if parts[1].contains(config.display_name) || parts[1] == config.app_name {
                        parts[0].to_string()
                    } else {
                        parts[1].to_string()
                    }
                }
                1 => {
                    if parts[0].contains(config.display_name) || parts[0] == config.app_name {
                        "New Window".to_string()
                    } else {
                        parts[0].to_string()
                    }
                }
                _ => title.to_string(),
            }
        }
    }
}

/// Focus a specific editor window by CGWindowID
/// Uses CGWindowID for reliable window identification regardless of title changes
pub fn focus_editor_window(bundle_id: &str, window_id: u32) -> Result<(), String> {
    let config = crate::editor_config::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    let pid = ax_helper::get_pid_by_bundle_id(config.bundle_id)
        .ok_or_else(|| format!("Editor not running: {}", config.display_name))?;

    ax_helper::focus_window_by_id(pid, window_id)
}

/// Open a new editor window
pub fn open_new_editor(bundle_id: &str) -> Result<(), String> {
    let config = crate::editor_config::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    let pid = ax_helper::get_pid_by_bundle_id(config.bundle_id)
        .ok_or_else(|| format!("Editor not running: {}", config.display_name))?;

    ax_helper::open_new_window_ax(pid)
}

/// Close a specific editor window by title (path)
/// Uses title-based matching to avoid index mismatch issues
pub fn close_editor_window(bundle_id: &str, window_path: &str) -> Result<(), String> {
    let config = crate::editor_config::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    let pid = ax_helper::get_pid_by_bundle_id(config.bundle_id)
        .ok_or_else(|| format!("Editor not running: {}", config.display_name))?;

    ax_helper::close_window_by_title(pid, window_path)
}
