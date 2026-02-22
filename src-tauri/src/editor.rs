use crate::ax_helper;
use crate::editor_config::{EditorConfig, EDITORS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

lazy_static::lazy_static! {
    /// プロジェクト名 → フルパスのキャッシュ
    static ref PROJECT_PATH_CACHE: std::sync::Mutex<HashMap<String, PathBuf>> =
        std::sync::Mutex::new(HashMap::new());
    /// エディタIDごとの初期化フラグ
    static ref CACHE_INITIALIZED: std::sync::Mutex<HashMap<String, bool>> =
        std::sync::Mutex::new(HashMap::new());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorWindow {
    pub id: u32,  // CGWindowID for reliable window identification
    pub name: String,
    pub path: String,
    pub branch: Option<String>,  // Git branch name
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

        let resolved_path = resolve_project_path(&name, config.id, pid, *window_id);
        let branch = resolved_path.as_ref()
            .and_then(|path| find_git_root(path).or(Some(path.clone())))
            .and_then(|git_root| get_git_branch(&git_root));
        let path_str = resolved_path
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        windows.push(EditorWindow {
            id: *window_id,  // Use CGWindowID for reliable identification
            name,
            path: path_str,
            branch,
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

            let resolved_path = resolve_project_path(&name, config.id, pid, *window_id);
            let branch = resolved_path.as_ref()
                .and_then(|path| find_git_root(path).or(Some(path.clone())))
                .and_then(|git_root| get_git_branch(&git_root));
            let path_str = resolved_path
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            Some(EditorWindow {
                id: *window_id,  // Use CGWindowID for reliable identification
                name,
                path: path_str,
                branch,
            })
        })
        .collect()
}

/// エディタIDからworkspaceStorageディレクトリのパスを返す
fn get_workspace_storage_dir(editor_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let subdir = match editor_id {
        "cursor" => "Cursor",
        "vscode" => "Code",
        _ => return None, // Zed等は非対応
    };
    Some(home.join("Library/Application Support").join(subdir).join("User/workspaceStorage"))
}

/// workspaceStorage内の全workspace.jsonを読み取り、プロジェクト名→フルパスのマッピングを返す
fn load_workspace_paths(editor_id: &str) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    let storage_dir = match get_workspace_storage_dir(editor_id) {
        Some(d) => d,
        None => return map,
    };
    let entries = match std::fs::read_dir(&storage_dir) {
        Ok(e) => e,
        Err(_) => return map,
    };
    for entry in entries.flatten() {
        let ws_json = entry.path().join("workspace.json");
        if let Ok(content) = std::fs::read_to_string(&ws_json) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(folder) = json.get("folder").and_then(|v| v.as_str()) {
                    let path_str = folder
                        .strip_prefix("file://")
                        .unwrap_or(folder);
                    // URLデコード（スペースなどの%エンコード対応）
                    let decoded = percent_decode(path_str);
                    let path = PathBuf::from(&decoded);
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        map.insert(name.to_string(), path);
                    }
                }
            }
        }
    }
    map
}

/// 簡易パーセントデコード（%XX → バイト変換）
fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(h), Some(l)) = (hi, lo) {
                if let Ok(decoded) = u8::from_str_radix(
                    &format!("{}{}", h as char, l as char),
                    16,
                ) {
                    bytes.push(decoded);
                    continue;
                }
            }
            bytes.push(b);
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| input.to_string())
}

/// プロジェクト名からフルパスを解決する
/// 1. キャッシュにあれば即返却
/// 2. キャッシュ未初期化 → workspaceStorage から一括読み込み → 再チェック
/// 3. フォールバック: AXDocument（前面ウィンドウでは動作）
fn resolve_project_path(
    project_name: &str,
    editor_id: &str,
    pid: i32,
    window_id: u32,
) -> Option<PathBuf> {
    // 1. キャッシュから検索
    {
        let cache = PROJECT_PATH_CACHE.lock().ok()?;
        if let Some(path) = cache.get(project_name) {
            return Some(path.clone());
        }
    }

    // 2. キャッシュ未初期化ならworkspaceStorageから読み込み
    {
        let mut initialized = CACHE_INITIALIZED.lock().ok()?;
        if !initialized.get(editor_id).copied().unwrap_or(false) {
            let paths = load_workspace_paths(editor_id);
            let mut cache = PROJECT_PATH_CACHE.lock().ok()?;
            for (name, path) in paths {
                cache.entry(name).or_insert(path);
            }
            initialized.insert(editor_id.to_string(), true);
        }
    }

    // キャッシュを再チェック
    {
        let cache = PROJECT_PATH_CACHE.lock().ok()?;
        if let Some(path) = cache.get(project_name) {
            return Some(path.clone());
        }
    }

    // 3. キャッシュ済みパスのサブディレクトリを検索（サブモジュール等）
    {
        let parent_paths: Vec<PathBuf> = {
            let cache = PROJECT_PATH_CACHE.lock().ok()?;
            cache.values().cloned().collect()
        };
        for parent_path in &parent_paths {
            let candidate = parent_path.join(project_name);
            if candidate.is_dir() && candidate.join(".git").exists() {
                if let Ok(mut cache) = PROJECT_PATH_CACHE.lock() {
                    cache.insert(project_name.to_string(), candidate.clone());
                }
                return Some(candidate);
            }
        }
    }

    // 4. フォールバック: AXDocument
    let doc_path = ax_helper::get_document_path(pid, window_id)?;
    let path = PathBuf::from(&doc_path);
    let parent = path.parent()?;
    let git_root = find_git_root(parent)?;

    // 成功時はキャッシュに追加
    if let Ok(mut cache) = PROJECT_PATH_CACHE.lock() {
        cache.insert(project_name.to_string(), git_root.clone());
    }

    Some(git_root)
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

/// Find git root by traversing up from start_path looking for .git directory
fn find_git_root(start_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut current = start_path;
    loop {
        if current.join(".git").exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}

/// .git の実体ディレクトリを解決する（サブモジュール対応）
/// サブモジュールでは .git がファイルで "gitdir: <path>" を含む
fn resolve_git_dir(git_root: &std::path::Path) -> Option<PathBuf> {
    let dot_git = git_root.join(".git");
    if dot_git.is_dir() {
        Some(dot_git)
    } else if dot_git.is_file() {
        let content = std::fs::read_to_string(&dot_git).ok()?;
        let gitdir = content.trim().strip_prefix("gitdir: ")?;
        let resolved = if std::path::Path::new(gitdir).is_absolute() {
            PathBuf::from(gitdir)
        } else {
            git_root.join(gitdir)
        };
        std::fs::canonicalize(resolved).ok()
    } else {
        None
    }
}

/// Read .git/HEAD to get current branch name
/// Returns branch name for normal branches, short commit hash for detached HEAD
/// Supports both regular repos and submodules
fn get_git_branch(git_root: &std::path::Path) -> Option<String> {
    let git_dir = resolve_git_dir(git_root)?;
    let head_path = git_dir.join("HEAD");
    let content = std::fs::read_to_string(head_path).ok()?;
    let content = content.trim();

    if let Some(ref_path) = content.strip_prefix("ref: refs/heads/") {
        Some(ref_path.to_string())
    } else if content.len() >= 7 {
        Some(content[..7].to_string())
    } else {
        None
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

/// Open a project directory in a specific editor
pub fn open_project_in_editor(bundle_id: &str, path: &str) -> Result<(), String> {
    let config = crate::editor_config::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    std::process::Command::new("open")
        .arg("-a")
        .arg(config.app_name)
        .arg(path)
        .spawn()
        .map_err(|e| format!("Failed to open project: {}", e))?;
    Ok(())
}

/// Close a specific editor window by CGWindowID
/// Uses CGWindowID for reliable window identification regardless of title changes
pub fn close_editor_window(bundle_id: &str, window_id: u32) -> Result<(), String> {
    let config = crate::editor_config::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;

    let pid = ax_helper::get_pid_by_bundle_id(config.bundle_id)
        .ok_or_else(|| format!("Editor not running: {}", config.display_name))?;

    ax_helper::close_window_by_id(pid, window_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn find_git_root_in_repo() {
        // This test runs inside the project's git repo
        let current_dir = std::env::current_dir().unwrap();
        let result = find_git_root(&current_dir);
        assert!(result.is_some());
        assert!(result.unwrap().join(".git").exists());
    }

    #[test]
    fn find_git_root_non_git() {
        let tmp = tempfile::tempdir().unwrap();
        let result = find_git_root(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn get_git_branch_normal() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let result = get_git_branch(tmp.path());
        assert_eq!(result, Some("main".to_string()));
    }

    #[test]
    fn get_git_branch_feature() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/feature/user/login\n").unwrap();

        let result = get_git_branch(tmp.path());
        assert_eq!(result, Some("feature/user/login".to_string()));
    }

    #[test]
    fn get_git_branch_detached_head() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), "a1b2c3d4e5f6789\n").unwrap();

        let result = get_git_branch(tmp.path());
        assert_eq!(result, Some("a1b2c3d".to_string()));
    }

    #[test]
    fn get_git_branch_no_head() {
        let tmp = tempfile::tempdir().unwrap();
        let result = get_git_branch(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn get_git_branch_submodule() {
        let tmp = tempfile::tempdir().unwrap();
        // 親リポジトリの .git/modules/sub を作成
        let modules_dir = tmp.path().join("parent/.git/modules/sub");
        fs::create_dir_all(&modules_dir).unwrap();
        fs::write(modules_dir.join("HEAD"), "ref: refs/heads/develop\n").unwrap();

        // サブモジュールの .git ファイルを作成
        let sub_dir = tmp.path().join("parent/sub");
        fs::create_dir_all(&sub_dir).unwrap();
        fs::write(sub_dir.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();

        let result = get_git_branch(&sub_dir);
        assert_eq!(result, Some("develop".to_string()));
    }

    #[test]
    fn resolve_git_dir_regular() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        fs::create_dir(&git_dir).unwrap();

        let result = resolve_git_dir(tmp.path());
        assert!(result.is_some());
        assert_eq!(result.unwrap(), git_dir);
    }

    #[test]
    fn resolve_git_dir_submodule() {
        let tmp = tempfile::tempdir().unwrap();
        let actual_git = tmp.path().join("actual_git");
        fs::create_dir(&actual_git).unwrap();

        let sub = tmp.path().join("sub");
        fs::create_dir(&sub).unwrap();
        // 絶対パスで gitdir を指定
        fs::write(sub.join(".git"), format!("gitdir: {}", actual_git.display())).unwrap();

        let result = resolve_git_dir(&sub);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), std::fs::canonicalize(&actual_git).unwrap());
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("/path/to/no%20encode"), "/path/to/no encode");
        assert_eq!(percent_decode("no_encoding"), "no_encoding");
    }

    #[test]
    fn percent_decode_japanese() {
        // %E3%83%86%E3%82%B9%E3%83%88 = "テスト" in UTF-8
        assert_eq!(percent_decode("%E3%83%86%E3%82%B9%E3%83%88"), "テスト");
    }

    #[test]
    fn load_workspace_paths_unsupported_editor() {
        let result = load_workspace_paths("zed");
        assert!(result.is_empty());
    }

    #[test]
    fn get_workspace_storage_dir_known_editors() {
        let cursor_dir = get_workspace_storage_dir("cursor");
        assert!(cursor_dir.is_some());
        assert!(cursor_dir.unwrap().to_string_lossy().contains("Cursor"));

        let vscode_dir = get_workspace_storage_dir("vscode");
        assert!(vscode_dir.is_some());
        assert!(vscode_dir.unwrap().to_string_lossy().contains("Code"));

        let zed_dir = get_workspace_storage_dir("zed");
        assert!(zed_dir.is_none());
    }
}
