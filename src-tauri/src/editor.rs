use crate::ax_helper;
use crate::editor_config::{EditorConfig, EDITORS};
use crate::editor_model::{EditorSession, NativeEditorWindow};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Condvar;
use std::time::{Duration, Instant};

pub use crate::editor_model::{
    EditorState, EditorWindow, ProjectMetadata, WorkspaceResolution,
};

type WindowPathCacheKey = (String, u32, String);
type WorkspacePathOwnerKey = (String, PathBuf);
const PENDING_PROJECT_OPEN_TTL: Duration = Duration::from_secs(30);
static NEXT_PENDING_PROJECT_OPEN_ID: AtomicU64 = AtomicU64::new(1);

lazy_static::lazy_static! {
    /// Editor ID + window ID + project name -> full path
    static ref WINDOW_PATH_CACHE: std::sync::Mutex<HashMap<WindowPathCacheKey, PathBuf>> =
        std::sync::Mutex::new(HashMap::new());
    static ref PENDING_PROJECT_OPENS:
        std::sync::Mutex<HashMap<String, Vec<PendingProjectOpen>>> =
        std::sync::Mutex::new(HashMap::new());
    static ref PENDING_PROJECT_OPEN_CHANGED: Condvar = Condvar::new();
    static ref PENDING_WINDOW_PATHS:
        std::sync::Mutex<HashMap<WindowPathCacheKey, PendingWindowPath>> =
        std::sync::Mutex::new(HashMap::new());
}

#[derive(Clone)]
struct PendingProjectOpen {
    request_id: u64,
    path: PathBuf,
    existing_window_ids: HashSet<u32>,
    created_at: Instant,
    is_ready: bool,
}

#[derive(Clone)]
struct PendingWindowPath {
    path: PathBuf,
    created_at: Instant,
}

#[derive(Default)]
struct OpenWorkspaceState {
    is_available: bool,
    active_path: Option<PathBuf>,
    all_paths: Vec<PathBuf>,
    paths_by_name: HashMap<String, Vec<PathBuf>>,
}

/// Get editor state for any running editor
/// Prioritizes the frontmost editor application
pub fn get_any_editor_state() -> EditorState {
    let editor_bundle_ids: Vec<&str> = EDITORS.iter().map(|e| e.bundle_id).collect();

    // 最前面のエディタを特定
    if let Some(frontmost_bid) = ax_helper::get_frontmost_editor_bundle_id(&editor_bundle_ids) {
        if let Some(config) = crate::editor_config::get_editor_by_bundle_id(&frontmost_bid) {
            let state = get_editor_state_with_config(config);
            if !state.windows.is_empty() {
                return state;
            }
        }
    }

    // フォールバック: 最前面がエディタでない場合（Tab Managerやその他アプリ）
    // ウィンドウを持つ最初のエディタを返す
    for editor in EDITORS {
        let state = get_editor_state_with_config(editor);
        if !state.windows.is_empty() {
            return state;
        }
    }

    EditorState {
        is_active: false,
        windows: vec![],
        active_index: None,
    }
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

    let (windows, active_id) = match collect_editor_windows(config, pid) {
        Ok(result) => result,
        Err(_) => return EditorState { is_active, windows: vec![], active_index: None },
    };
    let active_index = active_id.and_then(|active_id| {
        windows.iter().position(|window| window.id == active_id)
    });

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

    collect_editor_windows(config, pid)
        .map(|(windows, _)| windows)
        .unwrap_or_default()
}

fn collect_editor_windows(
    config: &EditorConfig,
    pid: i32,
) -> Result<(Vec<EditorWindow>, Option<u32>), String> {
    let native_windows = ax_helper::get_native_windows_ax(
        pid,
        config.bundle_id,
        config.id == "cursor",
    )?;
    let sessions = if config.id == "cursor" {
        crate::cursor_ipc::discover_sessions().unwrap_or_default()
    } else {
        Vec::new()
    };
    let session_resolutions = resolve_sessions(&native_windows, &sessions);
    let workspace_state = if sessions.is_empty() {
        load_open_workspace_state(config.id)
    } else {
        open_workspace_state_from_sessions(&sessions)
    };
    let ax_windows = native_windows
        .iter()
        .map(|window| (window.id, window.title.clone(), window.is_frontmost))
        .collect::<Vec<_>>();
    prepare_window_path_resolution(config, &ax_windows, &workspace_state);
    let project_window_counts = count_project_windows(config, &ax_windows);

    for (window_id, (path, _)) in &session_resolutions {
        if let Some(window) = native_windows.iter().find(|window| window.id == *window_id) {
            let name = extract_project_name(&window.title, config);
            cache_window_path(config.id, *window_id, &name, path);
        }
    }

    let mut standard_resolutions = HashMap::new();
    for window in native_windows
        .iter()
        .filter(|window| !window.title.is_empty() && window.title != "Untitled")
    {
        if let Some((path, resolution)) = session_resolutions.get(&window.id) {
            standard_resolutions.insert(window.id, (path.clone(), *resolution));
            continue;
        }
        let name = extract_project_name(&window.title, config);
        if let Some(path) = resolve_project_path(
            &name,
            config.id,
            pid,
            window.id,
            project_window_counts.get(&name).copied().unwrap_or(1),
            &workspace_state,
        ) {
            standard_resolutions.insert(window.id, (path, WorkspaceResolution::Inferred));
        }
    }
    let resolved_paths = standard_resolutions
        .iter()
        .map(|(window_id, (path, _))| (*window_id, path.clone()))
        .collect::<HashMap<_, _>>();
    acknowledge_resolved_pending_project_open(config, &resolved_paths);
    let resolved_window_ids = standard_resolutions.keys().copied().collect::<HashSet<_>>();
    let pending_resolutions =
        take_pending_project_open_paths(config, &native_windows, &resolved_window_ids);

    let active_id = native_windows
        .iter()
        .find(|window| window.is_frontmost)
        .map(|window| window.id);
    let windows = native_windows
        .iter()
        .filter_map(|window| {
            if window.title.is_empty() || window.title == "Untitled" {
                return None;
            }
            let name = extract_project_name(&window.title, config);
            let standard_resolution = standard_resolutions.get(&window.id);
            let resolved_path = standard_resolution
                .map(|(path, _)| path.clone())
                .or_else(|| pending_resolutions.get(&window.id).cloned());
            let resolution = standard_resolution
                .map(|(_, resolution)| *resolution)
                .or_else(|| resolved_path.as_ref().map(|_| WorkspaceResolution::Inferred))
                .unwrap_or(WorkspaceResolution::Unresolved);
            let git_root = resolved_path.as_ref().and_then(|path| find_git_root(path));
            let branch = git_root.as_ref().and_then(|root| get_git_branch(root));
            let repository = git_root.as_ref().and_then(|root| get_repository_info(root));

            Some(EditorWindow {
                runtime_id: window.runtime_id.clone(),
                id: window.id,
                name,
                path: resolved_path
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default(),
                branch,
                repository_id: repository.as_ref().map(|(id, _)| id.clone()),
                repository_name: repository.map(|(_, name)| name),
                bundle_id: config.bundle_id.to_string(),
                editor_name: config.display_name.to_string(),
                resolution,
            })
        })
        .collect();

    Ok((windows, active_id))
}

/// Get windows from ALL running editors
pub fn get_all_editor_windows() -> Vec<EditorWindow> {
    get_all_editor_window_snapshot().0
}

pub fn get_all_editor_window_snapshot() -> (Vec<EditorWindow>, Option<u32>) {
    let editor_bundle_ids = EDITORS.iter().map(|editor| editor.bundle_id).collect::<Vec<_>>();
    let frontmost_bundle_id = ax_helper::get_frontmost_editor_bundle_id(&editor_bundle_ids);
    let mut all_windows = Vec::new();
    let mut active_id = None;
    for editor in EDITORS {
        let Some(pid) = ax_helper::get_pid_by_bundle_id(editor.bundle_id) else {
            continue;
        };
        let Ok((windows, editor_active_id)) = collect_editor_windows(editor, pid) else {
            continue;
        };
        if frontmost_bundle_id.as_deref() == Some(editor.bundle_id) {
            active_id = editor_active_id;
        }
        all_windows.extend(windows);
    }
    (all_windows, active_id)
}

/// Invalidate window path assignments when an editor process changes.
pub fn invalidate_path_cache_for_editor(editor_id: &str) {
    if let Ok(mut cache) = WINDOW_PATH_CACHE.lock() {
        cache.retain(|(cached_editor_id, _, _), _| cached_editor_id != editor_id);
    }
    if let Ok(mut pending_paths) = PENDING_WINDOW_PATHS.lock() {
        pending_paths.retain(|(cached_editor_id, _, _), _| cached_editor_id != editor_id);
    }
}

fn resolve_sessions(
    native_windows: &[NativeEditorWindow],
    sessions: &[EditorSession],
) -> HashMap<u32, (PathBuf, WorkspaceResolution)> {
    let mut resolutions = HashMap::new();
    let mut assigned_sessions = HashSet::new();

    for window in native_windows {
        let matches = sessions
            .iter()
            .filter(|session| {
                session.path.is_some() && window.renderer_pids.contains(&session.renderer_pid)
            })
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            let session = matches[0];
            resolutions.insert(
                window.id,
                (session.path.clone().unwrap(), WorkspaceResolution::Exact),
            );
            assigned_sessions.insert(session.session_id.clone());
        }
    }

    let mut windows_by_creation = native_windows.iter().collect::<Vec<_>>();
    windows_by_creation.sort_by_key(|window| window.id);
    let mut sessions_by_creation = sessions.iter().collect::<Vec<_>>();
    sessions_by_creation.sort_by_key(|session| {
        session.session_id.parse::<u32>().unwrap_or(u32::MAX)
    });
    let creation_sequence_matches = windows_by_creation.len() == sessions_by_creation.len()
        && windows_by_creation
            .iter()
            .zip(&sessions_by_creation)
            .all(|(window, session)| window.title == session.title);
    if creation_sequence_matches {
        for (window, session) in windows_by_creation.iter().zip(&sessions_by_creation) {
            if resolutions.contains_key(&window.id)
                || assigned_sessions.contains(&session.session_id)
            {
                continue;
            }
            if let Some(path) = &session.path {
                resolutions.insert(
                    window.id,
                    (path.clone(), WorkspaceResolution::Inferred),
                );
                assigned_sessions.insert(session.session_id.clone());
            }
        }
    }

    for window in native_windows {
        if resolutions.contains_key(&window.id) {
            continue;
        }
        let same_title_windows = native_windows
            .iter()
            .filter(|candidate| {
                !resolutions.contains_key(&candidate.id) && candidate.title == window.title
            })
            .count();
        let matching_sessions = sessions
            .iter()
            .filter(|session| {
                session.path.is_some()
                    && !assigned_sessions.contains(&session.session_id)
                    && session.title == window.title
            })
            .collect::<Vec<_>>();
        if same_title_windows == 1 && matching_sessions.len() == 1 {
            let session = matching_sessions[0];
            resolutions.insert(
                window.id,
                (session.path.clone().unwrap(), WorkspaceResolution::Inferred),
            );
            assigned_sessions.insert(session.session_id.clone());
        }
    }

    resolutions
}

fn open_workspace_state_from_sessions(sessions: &[EditorSession]) -> OpenWorkspaceState {
    let mut all_paths = Vec::new();
    let mut paths_by_name = HashMap::new();

    for session in sessions {
        let Some(path) = &session.path else {
            continue;
        };
        if !path.exists() {
            continue;
        }
        add_unique_path(&mut all_paths, path.clone());
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            add_named_workspace_path(&mut paths_by_name, name, path);
        }
        add_named_workspace_path(&mut paths_by_name, &session.title, path);
    }

    OpenWorkspaceState {
        is_available: true,
        active_path: None,
        all_paths,
        paths_by_name,
    }
}

fn get_editor_user_dir(editor_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let subdir = match editor_id {
        "cursor" => "Cursor",
        "vscode" => "Code",
        _ => return None,
    };
    Some(
        home.join("Library/Application Support")
            .join(subdir)
            .join("User"),
    )
}

fn get_global_storage_file(editor_id: &str) -> Option<PathBuf> {
    Some(get_editor_user_dir(editor_id)?.join("globalStorage/storage.json"))
}

fn add_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

fn add_named_workspace_path(map: &mut HashMap<String, Vec<PathBuf>>, name: &str, path: &Path) {
    let paths = map.entry(name.to_string()).or_default();
    if !paths.iter().any(|candidate| candidate == path) {
        paths.push(path.to_path_buf());
    }
}

fn folder_path(value: &serde_json::Value) -> Option<PathBuf> {
    let folder = value.get("folder")?.as_str()?;
    let path = folder.strip_prefix("file://").unwrap_or(folder);
    Some(PathBuf::from(percent_decode(path)))
}

fn parse_open_workspace_paths(json: &serde_json::Value) -> (Option<PathBuf>, Vec<PathBuf>) {
    let windows_state = match json.get("windowsState") {
        Some(state) => state,
        None => return (None, Vec::new()),
    };
    let active_path = windows_state.get("lastActiveWindow").and_then(folder_path);
    let mut all_paths = Vec::new();

    if let Some(opened_windows) = windows_state
        .get("openedWindows")
        .and_then(|value| value.as_array())
    {
        for window in opened_windows {
            if let Some(path) = folder_path(window) {
                add_unique_path(&mut all_paths, path);
            }
        }
    }
    (active_path, all_paths)
}

fn load_open_workspace_state(editor_id: &str) -> OpenWorkspaceState {
    let Some(storage_file) = get_global_storage_file(editor_id) else {
        return OpenWorkspaceState::default();
    };
    let empty_state = || OpenWorkspaceState {
        is_available: true,
        ..OpenWorkspaceState::default()
    };
    let Ok(content) = std::fs::read_to_string(storage_file) else {
        return empty_state();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return empty_state();
    };
    let (active_path, all_paths) = parse_open_workspace_paths(&json);
    let all_paths: Vec<PathBuf> = all_paths.into_iter().filter(|path| path.exists()).collect();
    let active_path = active_path.filter(|path| all_paths.contains(path));
    let mut paths_by_name = HashMap::new();

    for path in &all_paths {
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            add_named_workspace_path(&mut paths_by_name, name, path);
        }
        if let Some((_, repository_name)) = find_git_root(path)
            .as_ref()
            .and_then(|root| get_repository_info(root))
        {
            add_named_workspace_path(&mut paths_by_name, &repository_name, path);
        }
    }

    OpenWorkspaceState {
        is_available: true,
        active_path,
        all_paths,
        paths_by_name,
    }
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

fn cache_window_path(editor_id: &str, window_id: u32, project_name: &str, path: &Path) {
    let key = (editor_id.to_string(), window_id, project_name.to_string());
    if let Ok(mut cache) = WINDOW_PATH_CACHE.lock() {
        cache.insert(key.clone(), path.to_path_buf());
    }
    if let Ok(mut pending_paths) = PENDING_WINDOW_PATHS.lock() {
        pending_paths.remove(&key);
    }
}

fn cache_pending_window_path(
    editor_id: &str,
    window_id: u32,
    project_name: &str,
    path: &Path,
) {
    let key = (editor_id.to_string(), window_id, project_name.to_string());
    if let Ok(mut cache) = WINDOW_PATH_CACHE.lock() {
        cache.insert(key.clone(), path.to_path_buf());
    }
    if let Ok(mut pending_paths) = PENDING_WINDOW_PATHS.lock() {
        pending_paths.insert(
            key,
            PendingWindowPath {
                path: path.to_path_buf(),
                created_at: Instant::now(),
            },
        );
    }
}

fn active_pending_window_paths(
    config: &EditorConfig,
    ax_windows: &[(u32, String, bool)],
) -> HashMap<WindowPathCacheKey, PathBuf> {
    let now = Instant::now();
    let mut pending_paths = match PENDING_WINDOW_PATHS.lock() {
        Ok(paths) => paths,
        Err(_) => return HashMap::new(),
    };
    pending_paths.retain(|(editor_id, window_id, project_name), pending| {
        if editor_id != config.id {
            return true;
        }
        now.duration_since(pending.created_at) <= PENDING_PROJECT_OPEN_TTL
            && ax_windows.iter().any(|(id, title, _)| {
                id == window_id && extract_project_name(title, config) == *project_name
            })
    });
    pending_paths
        .iter()
        .filter(|((editor_id, _, _), _)| editor_id == config.id)
        .map(|(key, pending)| (key.clone(), pending.path.clone()))
        .collect()
}

fn pending_window_path(key: &WindowPathCacheKey) -> Option<PathBuf> {
    let now = Instant::now();
    let mut pending_paths = PENDING_WINDOW_PATHS.lock().ok()?;
    let is_expired = pending_paths
        .get(key)
        .is_some_and(|pending| now.duration_since(pending.created_at) > PENDING_PROJECT_OPEN_TTL);
    if is_expired {
        pending_paths.remove(key);
    }
    pending_paths.get(key).map(|pending| pending.path.clone())
}

fn workspace_path_for_document(candidates: &[PathBuf], document_path: &Path) -> Option<PathBuf> {
    candidates
        .iter()
        .filter(|candidate| document_path.starts_with(candidate))
        .max_by_key(|candidate| candidate.components().count())
        .cloned()
}

fn count_project_windows(
    config: &EditorConfig,
    ax_windows: &[(u32, String, bool)],
) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for (_, title, _) in ax_windows {
        if title.is_empty() || title == "Untitled" {
            continue;
        }
        *counts.entry(extract_project_name(title, config)).or_default() += 1;
    }
    counts
}

fn single_unassigned_workspace_path(
    candidates: &[PathBuf],
    assigned_paths: &[PathBuf],
    unassigned_window_count: usize,
) -> Option<PathBuf> {
    if unassigned_window_count != 1 {
        return None;
    }
    let mut unassigned = candidates
        .iter()
        .filter(|candidate| !assigned_paths.contains(candidate));
    let path = unassigned.next()?.clone();
    unassigned.next().is_none().then_some(path)
}

fn prepare_window_path_resolution(
    config: &EditorConfig,
    ax_windows: &[(u32, String, bool)],
    workspace_state: &OpenWorkspaceState,
) {
    let pending_paths = active_pending_window_paths(config, ax_windows);
    let active_window = workspace_state
        .active_path
        .as_ref()
        .and_then(|active_path| {
            let (window_id, title, _) = ax_windows.iter().find(|(_, title, is_frontmost)| {
                *is_frontmost && !title.is_empty() && title != "Untitled"
            })?;
            let project_name = extract_project_name(title, config);
            let is_candidate = workspace_state
                .paths_by_name
                .get(&project_name)
                .is_some_and(|paths| paths.contains(active_path));
            let key = (config.id.to_string(), *window_id, project_name.clone());
            let conflicts_with_pending =
                pending_paths.get(&key).is_some_and(|path| path != active_path);
            (is_candidate && !conflicts_with_pending)
                .then(|| (*window_id, project_name, active_path.clone()))
        });

    let mut cache = match WINDOW_PATH_CACHE.lock() {
        Ok(cache) => cache,
        Err(_) => return,
    };
    cache.retain(|(editor_id, window_id, project_name), path| {
        if editor_id != config.id {
            return true;
        }
        let window_exists = ax_windows.iter().any(|(id, _, _)| id == window_id);
        let path_is_open = !workspace_state.is_available
            || workspace_state
                .paths_by_name
                .get(project_name)
                .is_some_and(|paths| paths.contains(path));
        let path_is_pending = pending_paths.get(&(
            editor_id.clone(),
            *window_id,
            project_name.clone(),
        )) == Some(path);
        window_exists && (path_is_open || path_is_pending)
    });

    let active_key = active_window.map(|(window_id, project_name, active_path)| {
        let key = (config.id.to_string(), window_id, project_name);
        cache.insert(key.clone(), active_path);
        key
    });

    let mut path_owners: HashMap<WorkspacePathOwnerKey, (WindowPathCacheKey, bool)> =
        HashMap::new();
    let mut duplicate_keys = Vec::new();
    for (key, path) in cache.iter().filter(|(key, _)| key.0 == config.id) {
        let owner_key = (key.2.clone(), path.clone());
        let is_preferred =
            active_key.as_ref() == Some(key) || pending_paths.get(key) == Some(path);
        if let Some((existing_key, existing_is_preferred)) = path_owners.get(&owner_key) {
            if is_preferred && !existing_is_preferred {
                duplicate_keys.push(existing_key.clone());
                path_owners.insert(owner_key, (key.clone(), true));
            } else {
                duplicate_keys.push(key.clone());
            }
        } else {
            path_owners.insert(owner_key, (key.clone(), is_preferred));
        }
    }
    for key in duplicate_keys {
        cache.remove(&key);
    }
    drop(cache);

    if let Some(active_key) = active_key {
        if let Ok(mut pending_paths) = PENDING_WINDOW_PATHS.lock() {
            pending_paths.remove(&active_key);
        }
    }
}

/// Resolve a full path from the project name and window metadata
fn resolve_project_path(
    project_name: &str,
    editor_id: &str,
    pid: i32,
    window_id: u32,
    project_window_count: usize,
    workspace_state: &OpenWorkspaceState,
) -> Option<PathBuf> {
    let document_path = ax_helper::get_document_path(pid, window_id).map(PathBuf::from);

    if let Some(document_path) = document_path {
        // Use the containing workspace to distinguish same-named worktrees and submodules
        if let Some(workspace_path) =
            workspace_path_for_document(&workspace_state.all_paths, &document_path)
        {
            cache_window_path(editor_id, window_id, project_name, &workspace_path);
            return Some(workspace_path);
        }
        if let Some(git_root) = find_git_root(&document_path) {
            cache_window_path(editor_id, window_id, project_name, &git_root);
            return Some(git_root);
        }
    }

    let window_cache_key = (editor_id.to_string(), window_id, project_name.to_string());
    let candidates = workspace_state
        .paths_by_name
        .get(project_name)
        .cloned()
        .unwrap_or_default();
    let protected_path = pending_window_path(&window_cache_key);
    let mut cache = WINDOW_PATH_CACHE.lock().ok()?;
    if let Some(path) = cache.get(&window_cache_key) {
        if protected_path.as_ref() == Some(path)
            || !workspace_state.is_available
            || candidates.contains(path)
        {
            return Some(path.clone());
        }
        cache.remove(&window_cache_key);
    }

    let assigned_paths: Vec<PathBuf> = cache
        .iter()
        .filter(
            |((cached_editor_id, cached_window_id, cached_project_name), path)| {
                cached_editor_id == editor_id
                    && *cached_window_id != window_id
                    && cached_project_name == project_name
                    && candidates.contains(path)
            },
        )
        .map(|(_, path)| path.clone())
        .collect();
    let unassigned_window_count = project_window_count.saturating_sub(assigned_paths.len());
    let path = single_unassigned_workspace_path(
        &candidates,
        &assigned_paths,
        unassigned_window_count,
    )?;
    cache.insert(window_cache_key, path.clone());
    Some(path)
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
                        config.display_name.to_string()
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

/// Resolve the shared Git directory so linked worktrees use one repository identity.
fn resolve_git_common_dir(git_root: &Path) -> Option<PathBuf> {
    let git_dir = resolve_git_dir(git_root)?;
    let common_dir_file = git_dir.join("commondir");
    let common_dir = if common_dir_file.is_file() {
        let content = std::fs::read_to_string(common_dir_file).ok()?;
        let path = Path::new(content.trim());
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            git_dir.join(path)
        }
    } else {
        git_dir
    };

    std::fs::canonicalize(common_dir).ok()
}

fn get_repository_info(git_root: &Path) -> Option<(String, String)> {
    let common_dir = resolve_git_common_dir(git_root)?;
    let repository_name = if common_dir
        .file_name()
        .and_then(|name| name.to_str())
        == Some(".git")
    {
        common_dir.parent()?.file_name()?.to_str()?.to_string()
    } else {
        git_root.file_name()?.to_str()?.to_string()
    };

    Some((common_dir.to_string_lossy().to_string(), repository_name))
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

pub fn get_project_metadata(paths: Vec<String>) -> Vec<ProjectMetadata> {
    let mut seen_paths = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen_paths.insert(path.clone()))
        .map(|path| {
            let git_root = find_git_root(Path::new(&path));
            let branch = git_root.as_ref().and_then(|root| get_git_branch(root));
            let repository = git_root.as_ref().and_then(|root| get_repository_info(root));
            ProjectMetadata {
                path,
                branch,
                repository_id: repository.as_ref().map(|(id, _)| id.clone()),
                repository_name: repository.map(|(_, name)| name),
            }
        })
        .collect()
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

    if let Some(pid) = ax_helper::get_pid_by_bundle_id(config.bundle_id) {
        return ax_helper::open_new_window_ax(pid);
    }

    let status = std::process::Command::new("open")
        .arg("-a")
        .arg(config.app_name)
        .status()
        .map_err(|e| format!("Failed to launch editor: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Failed to launch {}", config.display_name))
    }
}

fn find_zed_cli() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/usr/local/bin/zed"),
        PathBuf::from("/opt/homebrew/bin/zed"),
        PathBuf::from("/Applications/Zed.app/Contents/MacOS/cli"),
    ];
    if let Some(home_dir) = std::env::var_os("HOME") {
        candidates.push(
            PathBuf::from(home_dir).join("Applications/Zed.app/Contents/MacOS/cli"),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn current_editor_window_ids(config: &EditorConfig) -> Result<HashSet<u32>, String> {
    let Some(pid) = ax_helper::get_pid_by_bundle_id(config.bundle_id) else {
        return Ok(HashSet::new());
    };
    ax_helper::get_native_windows_ax(pid, config.bundle_id, config.id == "cursor")
        .map_err(|error| format!("Failed to inspect existing editor windows: {}", error))
        .map(|windows| windows.into_iter().map(|window| window.id).collect())
}

fn project_path_matches_name(path: &Path, project_name: &str) -> bool {
    if path.file_name().and_then(|name| name.to_str()) == Some(project_name) {
        return true;
    }
    find_git_root(path)
        .and_then(|root| get_repository_info(&root))
        .is_some_and(|(_, repository_name)| repository_name == project_name)
}

fn match_pending_project_opens(
    config: &EditorConfig,
    pending_opens: &[PendingProjectOpen],
    native_windows: &[NativeEditorWindow],
    resolved_window_ids: &HashSet<u32>,
) -> (HashMap<u32, PathBuf>, HashSet<usize>) {
    let windows = native_windows
        .iter()
        .filter(|window| !window.title.is_empty() && window.title != "Untitled")
        .map(|window| (window.id, extract_project_name(&window.title, config)))
        .collect::<Vec<_>>();
    let mut pending_indices = (0..pending_opens.len()).collect::<Vec<_>>();
    pending_indices.sort_by_key(|index| {
        std::cmp::Reverse(pending_opens[*index].existing_window_ids.len())
    });

    let mut assigned_window_ids = HashSet::new();
    let mut consumed_pending_indices = HashSet::new();
    let mut matches = HashMap::new();

    for index in pending_indices {
        let pending = &pending_opens[index];
        if !pending.is_ready {
            continue;
        }
        let candidates = windows
            .iter()
            .filter(|(window_id, project_name)| {
                !pending.existing_window_ids.contains(window_id)
                    && !resolved_window_ids.contains(window_id)
                    && !assigned_window_ids.contains(window_id)
                    && project_path_matches_name(&pending.path, project_name)
            })
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            continue;
        }

        let (window_id, project_name) = candidates[0];
        let has_competing_open = pending_opens
            .iter()
            .enumerate()
            .any(|(other_index, other)| {
                other_index != index
                    && !consumed_pending_indices.contains(&other_index)
                    && other.existing_window_ids == pending.existing_window_ids
                    && project_path_matches_name(&other.path, project_name)
            });
        if has_competing_open {
            continue;
        }

        assigned_window_ids.insert(*window_id);
        consumed_pending_indices.insert(index);
        matches.insert(*window_id, pending.path.clone());
    }

    (matches, consumed_pending_indices)
}

fn prune_expired_pending_project_opens(
    pending_by_editor: &mut HashMap<String, Vec<PendingProjectOpen>>,
    editor_id: &str,
) -> bool {
    let now = Instant::now();
    let mut removed = false;
    let is_empty = if let Some(pending_opens) = pending_by_editor.get_mut(editor_id) {
        let previous_len = pending_opens.len();
        pending_opens.retain(|pending| {
            now.duration_since(pending.created_at) <= PENDING_PROJECT_OPEN_TTL
        });
        removed = pending_opens.len() != previous_len;
        pending_opens.is_empty()
    } else {
        false
    };
    if is_empty {
        pending_by_editor.remove(editor_id);
    }
    removed
}

fn reserve_pending_project_open(editor_id: &str, path: &Path) -> Result<u64, String> {
    let mut pending_by_editor = PENDING_PROJECT_OPENS
        .lock()
        .map_err(|_| "Project open coordinator is unavailable".to_string())?;

    loop {
        if prune_expired_pending_project_opens(&mut pending_by_editor, editor_id) {
            PENDING_PROJECT_OPEN_CHANGED.notify_all();
        }
        if !pending_by_editor.contains_key(editor_id) {
            let request_id = NEXT_PENDING_PROJECT_OPEN_ID.fetch_add(1, Ordering::Relaxed);
            pending_by_editor.insert(
                editor_id.to_string(),
                vec![PendingProjectOpen {
                    request_id,
                    path: path.to_path_buf(),
                    existing_window_ids: HashSet::new(),
                    created_at: Instant::now(),
                    is_ready: false,
                }],
            );
            return Ok(request_id);
        }

        let wait_duration = pending_by_editor
            .get(editor_id)
            .and_then(|pending_opens| {
                pending_opens
                    .iter()
                    .map(|pending| {
                        PENDING_PROJECT_OPEN_TTL
                            .saturating_sub(pending.created_at.elapsed())
                    })
                    .min()
            });
        pending_by_editor = if let Some(wait_duration) = wait_duration {
            PENDING_PROJECT_OPEN_CHANGED
                .wait_timeout(pending_by_editor, wait_duration)
                .map_err(|_| "Project open coordinator is unavailable".to_string())?
                .0
        } else {
            PENDING_PROJECT_OPEN_CHANGED
                .wait(pending_by_editor)
                .map_err(|_| "Project open coordinator is unavailable".to_string())?
        };
    }
}

fn mark_pending_project_open_ready(
    editor_id: &str,
    request_id: u64,
    existing_window_ids: HashSet<u32>,
) -> Result<(), String> {
    let mut pending_by_editor = PENDING_PROJECT_OPENS
        .lock()
        .map_err(|_| "Project open coordinator is unavailable".to_string())?;
    let pending = pending_by_editor
        .get_mut(editor_id)
        .and_then(|pending_opens| {
            pending_opens
                .iter_mut()
                .find(|pending| pending.request_id == request_id)
        })
        .ok_or_else(|| "Project open request was cancelled".to_string())?;
    pending.existing_window_ids = existing_window_ids;
    pending.created_at = Instant::now();
    pending.is_ready = true;
    PENDING_PROJECT_OPEN_CHANGED.notify_all();
    Ok(())
}

fn cancel_pending_project_open(editor_id: &str, request_id: u64) {
    if let Ok(mut pending_by_editor) = PENDING_PROJECT_OPENS.lock() {
        let is_empty = if let Some(pending_opens) = pending_by_editor.get_mut(editor_id) {
            pending_opens.retain(|pending| pending.request_id != request_id);
            pending_opens.is_empty()
        } else {
            false
        };
        if is_empty {
            pending_by_editor.remove(editor_id);
        }
        PENDING_PROJECT_OPEN_CHANGED.notify_all();
    }
}

fn snapshot_pending_project_opens(editor_id: &str) -> Vec<PendingProjectOpen> {
    let mut pending_by_editor = match PENDING_PROJECT_OPENS.lock() {
        Ok(pending) => pending,
        Err(_) => return Vec::new(),
    };
    if prune_expired_pending_project_opens(&mut pending_by_editor, editor_id) {
        PENDING_PROJECT_OPEN_CHANGED.notify_all();
    }
    pending_by_editor
        .get(editor_id)
        .map(|pending_opens| {
            pending_opens
                .iter()
                .filter(|pending| pending.is_ready)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn consume_pending_project_opens(editor_id: &str, request_ids: &HashSet<u64>) -> bool {
    let mut pending_by_editor = match PENDING_PROJECT_OPENS.lock() {
        Ok(pending) => pending,
        Err(_) => return false,
    };
    let mut consumed = 0;
    let is_empty = if let Some(pending_opens) = pending_by_editor.get_mut(editor_id) {
        let previous_len = pending_opens.len();
        pending_opens.retain(|pending| !request_ids.contains(&pending.request_id));
        consumed = previous_len - pending_opens.len();
        pending_opens.is_empty()
    } else {
        false
    };
    if is_empty {
        pending_by_editor.remove(editor_id);
    }
    if consumed > 0 {
        PENDING_PROJECT_OPEN_CHANGED.notify_all();
    }
    consumed == request_ids.len()
}

fn paths_refer_to_same_project(first: &Path, second: &Path) -> bool {
    first == second
        || std::fs::canonicalize(first)
            .ok()
            .zip(std::fs::canonicalize(second).ok())
            .is_some_and(|(first, second)| first == second)
}

fn acknowledge_resolved_pending_project_open(
    config: &EditorConfig,
    resolved_paths: &HashMap<u32, PathBuf>,
) {
    let pending_opens = snapshot_pending_project_opens(config.id);
    let request_ids = pending_opens
        .iter()
        .filter(|pending| {
            resolved_paths
                .values()
                .any(|path| paths_refer_to_same_project(&pending.path, path))
        })
        .map(|pending| pending.request_id)
        .collect::<HashSet<_>>();
    if !request_ids.is_empty() {
        consume_pending_project_opens(config.id, &request_ids);
    }
}

fn take_pending_project_open_paths(
    config: &EditorConfig,
    native_windows: &[NativeEditorWindow],
    resolved_window_ids: &HashSet<u32>,
) -> HashMap<u32, PathBuf> {
    let pending_opens = snapshot_pending_project_opens(config.id);
    let (matches, consumed_indices) = match_pending_project_opens(
        config,
        &pending_opens,
        native_windows,
        resolved_window_ids,
    );
    let request_ids = consumed_indices
        .iter()
        .map(|index| pending_opens[*index].request_id)
        .collect::<HashSet<_>>();
    if request_ids.is_empty()
        || !consume_pending_project_opens(config.id, &request_ids)
    {
        return HashMap::new();
    }

    for (window_id, path) in &matches {
        if let Some(window) = native_windows.iter().find(|window| window.id == *window_id) {
            let project_name = extract_project_name(&window.title, config);
            cache_pending_window_path(config.id, *window_id, &project_name, path);
        }
    }
    matches
}

fn build_project_open_command(
    config: &EditorConfig,
    path: &str,
    zed_cli: Option<&Path>,
) -> Result<std::process::Command, String> {
    if config.id == "zed" {
        let cli = zed_cli.ok_or_else(|| {
            "Zed CLI not found. Install it from Zed's command palette.".to_string()
        })?;
        let mut command = std::process::Command::new(cli);
        command.arg("-n").arg(path);
        return Ok(command);
    }

    let mut command = std::process::Command::new("open");
    command.arg("-a").arg(config.app_name).arg(path);
    Ok(command)
}

/// Open a project directory in a specific editor
pub fn open_project_in_editor(bundle_id: &str, path: &str) -> Result<(), String> {
    let config = crate::editor_config::get_editor_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Unknown editor: {}", bundle_id))?;
    if !Path::new(path).exists() {
        return Err(format!("Project path does not exist: {}", path));
    }

    let request_id = reserve_pending_project_open(config.id, Path::new(path))?;
    let existing_window_ids = current_editor_window_ids(config).ok();
    let zed_cli = (config.id == "zed").then(find_zed_cli).flatten();
    let status = match build_project_open_command(config, path, zed_cli.as_deref())
        .and_then(|mut command| {
            command
                .status()
                .map_err(|e| format!("Failed to open project: {}", e))
        }) {
        Ok(status) => status,
        Err(error) => {
            cancel_pending_project_open(config.id, request_id);
            return Err(error);
        }
    };
    if status.success() {
        if let Some(existing_window_ids) = existing_window_ids {
            if let Err(error) =
                mark_pending_project_open_ready(config.id, request_id, existing_window_ids)
            {
                cancel_pending_project_open(config.id, request_id);
                return Err(error);
            }
        } else {
            cancel_pending_project_open(config.id, request_id);
        }
        crate::window_registry::request_refresh("project-open");
        Ok(())
    } else {
        cancel_pending_project_open(config.id, request_id);
        Err(format!("Failed to open project in {}", config.display_name))
    }
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

    fn native_window(id: u32, title: &str) -> NativeEditorWindow {
        NativeEditorWindow::new("cursor", 10, id, title.to_string(), false, Vec::new())
    }

    fn pending_open(path: &str, existing_window_ids: &[u32]) -> PendingProjectOpen {
        PendingProjectOpen {
            request_id: 0,
            path: PathBuf::from(path),
            existing_window_ids: existing_window_ids.iter().copied().collect(),
            created_at: Instant::now(),
            is_ready: true,
        }
    }

    #[test]
    fn open_project_rejects_a_missing_path() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing");

        let result =
            open_project_in_editor("com.microsoft.VSCode", missing.to_str().unwrap());

        assert!(result.unwrap_err().contains("Project path does not exist"));
    }

    #[test]
    fn zed_project_command_forces_a_new_window() {
        let config =
            crate::editor_config::get_editor_by_bundle_id("dev.zed.Zed").unwrap();
        let command = build_project_open_command(
            config,
            "/projects/word-diary",
            Some(Path::new("/mock/zed")),
        )
        .unwrap();

        assert_eq!(command.get_program(), "/mock/zed");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-n", "/projects/word-diary"]
        );
    }

    #[test]
    fn vscode_project_command_keeps_the_existing_open_behavior() {
        let config =
            crate::editor_config::get_editor_by_bundle_id("com.microsoft.VSCode").unwrap();
        let command =
            build_project_open_command(config, "/projects/api", None).unwrap();

        assert_eq!(command.get_program(), "open");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-a", "Visual Studio Code", "/projects/api"]
        );
    }

    #[test]
    fn pending_open_matches_a_new_window_for_vscode_and_cursor() {
        for (bundle_id, title) in [
            ("com.microsoft.VSCode", "api — Visual Studio Code"),
            ("com.todesktop.230313mzl4w4u92", "api — Cursor"),
        ] {
            let config = crate::editor_config::get_editor_by_bundle_id(bundle_id).unwrap();
            let pending = vec![pending_open("/projects/api", &[100])];
            let windows = vec![native_window(100, title), native_window(200, title)];

            let (matches, consumed) = match_pending_project_opens(
                config,
                &pending,
                &windows,
                &HashSet::new(),
            );

            assert_eq!(matches[&200], PathBuf::from("/projects/api"));
            assert_eq!(consumed, HashSet::from([0]));
        }
    }

    #[test]
    fn pending_opens_match_same_named_zed_worktrees_by_new_window_id() {
        let config =
            crate::editor_config::get_editor_by_bundle_id("dev.zed.Zed").unwrap();
        let pending = vec![
            pending_open("/worktrees/one/project", &[100]),
            pending_open("/worktrees/two/project", &[100, 200]),
        ];
        let windows = vec![
            native_window(100, "project"),
            native_window(200, "project"),
            native_window(300, "project"),
        ];

        let (matches, consumed) = match_pending_project_opens(
            config,
            &pending,
            &windows,
            &HashSet::new(),
        );

        assert_eq!(matches[&200], PathBuf::from("/worktrees/one/project"));
        assert_eq!(matches[&300], PathBuf::from("/worktrees/two/project"));
        assert_eq!(consumed, HashSet::from([0, 1]));
    }

    #[test]
    fn pending_opens_do_not_guess_when_same_named_windows_are_ambiguous() {
        let config =
            crate::editor_config::get_editor_by_bundle_id("dev.zed.Zed").unwrap();
        let pending = vec![
            pending_open("/worktrees/one/project", &[100]),
            pending_open("/worktrees/two/project", &[100]),
        ];
        let windows = vec![
            native_window(100, "project"),
            native_window(200, "project"),
        ];

        let (matches, consumed) = match_pending_project_opens(
            config,
            &pending,
            &windows,
            &HashSet::new(),
        );

        assert!(matches.is_empty());
        assert!(consumed.is_empty());
    }

    #[test]
    fn pending_open_does_not_consume_an_already_resolved_window() {
        let config =
            crate::editor_config::get_editor_by_bundle_id("com.microsoft.VSCode").unwrap();
        let pending = vec![pending_open("/projects/api", &[100])];
        let windows = vec![
            native_window(100, "api — Visual Studio Code"),
            native_window(200, "api — Visual Studio Code"),
        ];

        let (matches, consumed) = match_pending_project_opens(
            config,
            &pending,
            &windows,
            &HashSet::from([200]),
        );

        assert!(matches.is_empty());
        assert!(consumed.is_empty());
    }

    #[test]
    fn resolved_existing_target_acknowledges_pending_open() {
        let config = EditorConfig {
            id: "pending-acknowledgement-test",
            display_name: "Sample Editor",
            bundle_id: "com.example.pending-acknowledgement",
            app_name: "Sample Editor",
        };
        let path = PathBuf::from("/projects/api");
        let request_id = reserve_pending_project_open(config.id, &path).unwrap();
        mark_pending_project_open_ready(
            config.id,
            request_id,
            HashSet::from([100]),
        )
        .unwrap();

        acknowledge_resolved_pending_project_open(
            &config,
            &HashMap::from([(100, path.clone())]),
        );
        assert!(snapshot_pending_project_opens(config.id).is_empty());
    }

    #[test]
    fn project_open_reservations_are_serialized_per_editor() {
        let config = EditorConfig {
            id: "pending-serialization-test",
            display_name: "Sample Editor",
            bundle_id: "com.example.pending-serialization",
            app_name: "Sample Editor",
        };
        let first = reserve_pending_project_open(
            config.id,
            Path::new("/worktrees/one/project"),
        )
        .unwrap();
        mark_pending_project_open_ready(config.id, first, HashSet::from([100])).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let second = reserve_pending_project_open(
                "pending-serialization-test",
                Path::new("/worktrees/two/project"),
            )
            .unwrap();
            tx.send(second).unwrap();
        });

        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());

        let matches = take_pending_project_open_paths(
            &config,
            &[native_window(100, "project"), native_window(200, "project")],
            &HashSet::new(),
        );
        assert_eq!(
            matches.get(&200),
            Some(&PathBuf::from("/worktrees/one/project"))
        );
        let second = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        cancel_pending_project_open(config.id, second);
        waiter.join().unwrap();
        invalidate_path_cache_for_editor(config.id);
    }

    #[test]
    fn launching_reservation_expires_instead_of_blocking_forever() {
        let editor_id = "pending-launch-timeout-test";
        {
            let mut pending_by_editor = PENDING_PROJECT_OPENS.lock().unwrap();
            pending_by_editor.insert(
                editor_id.to_string(),
                vec![PendingProjectOpen {
                    request_id: 999,
                    path: PathBuf::from("/worktrees/old/project"),
                    existing_window_ids: HashSet::new(),
                    created_at: Instant::now()
                        .checked_sub(PENDING_PROJECT_OPEN_TTL + Duration::from_secs(1))
                        .unwrap(),
                    is_ready: false,
                }],
            );
        }

        let request_id =
            reserve_pending_project_open(editor_id, Path::new("/worktrees/new/project")).unwrap();

        assert_ne!(request_id, 999);
        cancel_pending_project_open(editor_id, request_id);
    }

    #[test]
    fn pending_window_path_survives_stale_workspace_state() {
        let config = EditorConfig {
            id: "pending-cache-test",
            display_name: "Sample Editor",
            bundle_id: "com.example.pending-cache",
            app_name: "Sample Editor",
        };
        let path = PathBuf::from("/worktrees/one/project");
        let stale_active_path = PathBuf::from("/worktrees/old/project");
        cache_pending_window_path(config.id, 200, "project", &path);
        let windows = vec![(200, "project — Sample Editor".to_string(), true)];
        let workspace_state = OpenWorkspaceState {
            is_available: true,
            active_path: Some(stale_active_path.clone()),
            all_paths: vec![stale_active_path.clone()],
            paths_by_name: HashMap::from([(
                "project".to_string(),
                vec![stale_active_path],
            )]),
        };

        prepare_window_path_resolution(&config, &windows, &workspace_state);

        let cache = WINDOW_PATH_CACHE.lock().unwrap();
        assert_eq!(
            cache.get(&(config.id.to_string(), 200, "project".to_string())),
            Some(&path)
        );
        drop(cache);
        invalidate_path_cache_for_editor(config.id);
    }

    fn editor_session(id: u32, title: &str, path: Option<&str>) -> EditorSession {
        EditorSession {
            session_id: id.to_string(),
            renderer_pid: 1000 + id as i32,
            title: title.to_string(),
            path: path.map(PathBuf::from),
        }
    }

    #[test]
    fn cursor_sessions_are_resolved_by_creation_ids_not_input_order() {
        let windows = vec![
            native_window(400, "project"),
            native_window(100, "project"),
            native_window(300, "Cursor Agents"),
            native_window(200, "api"),
        ];
        let sessions = vec![
            editor_session(4, "project", Some("/worktrees/project")),
            editor_session(2, "api", Some("/projects/api")),
            editor_session(1, "project", Some("/projects/project")),
            editor_session(3, "Cursor Agents", None),
        ];

        let resolved = resolve_sessions(&windows, &sessions);

        assert_eq!(resolved[&100].0, PathBuf::from("/projects/project"));
        assert_eq!(resolved[&200].0, PathBuf::from("/projects/api"));
        assert_eq!(resolved[&400].0, PathBuf::from("/worktrees/project"));
    }

    #[test]
    fn duplicate_titles_remain_unresolved_when_creation_sequence_disagrees() {
        let windows = vec![
            native_window(100, "project"),
            native_window(200, "project"),
        ];
        let sessions = vec![
            editor_session(1, "project", Some("/projects/project")),
            editor_session(2, "different", Some("/worktrees/project")),
        ];

        let resolved = resolve_sessions(&windows, &sessions);

        assert!(resolved.is_empty());
    }

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
    fn find_git_root_from_file_in_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree = tmp.path().join("worktrees/project");
        let source_dir = worktree.join("src");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            worktree.join(".git"),
            "gitdir: /tmp/repo/.git/worktrees/project\n",
        )
        .unwrap();
        let source_file = source_dir.join("main.rs");
        fs::write(&source_file, "fn main() {}\n").unwrap();

        assert_eq!(find_git_root(&source_file), Some(worktree));
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
    fn get_git_branch_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join("main/.git/worktrees/feature");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/feature/worktree\n").unwrap();

        let worktree = tmp.path().join("worktrees/project");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .unwrap();

        assert_eq!(
            get_git_branch(&worktree),
            Some("feature/worktree".to_string())
        );
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
    fn linked_worktree_uses_main_repository_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("project");
        let main_git = main.join(".git");
        let worktree_git = main_git.join("worktrees/feature");
        fs::create_dir_all(&worktree_git).unwrap();

        let worktree = tmp.path().join("project-feature");
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", worktree_git.display()),
        )
        .unwrap();
        fs::write(worktree_git.join("commondir"), "../..\n").unwrap();

        let main_info = get_repository_info(&main).unwrap();
        let worktree_info = get_repository_info(&worktree).unwrap();

        assert_eq!(main_info, worktree_info);
        assert_eq!(main_info.1, "project");
    }

    #[test]
    fn project_metadata_restores_linked_worktree_git_information() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("project");
        let main_git = main.join(".git");
        let worktree_git = main_git.join("worktrees/feature");
        fs::create_dir_all(&worktree_git).unwrap();

        let worktree = tmp.path().join("project-feature");
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", worktree_git.display()),
        )
        .unwrap();
        fs::write(worktree_git.join("commondir"), "../..\n").unwrap();
        fs::write(
            worktree_git.join("HEAD"),
            "ref: refs/heads/feature/saved-tab\n",
        )
        .unwrap();

        let metadata =
            get_project_metadata(vec![worktree.to_string_lossy().to_string()]);

        assert_eq!(metadata.len(), 1);
        assert_eq!(
            metadata[0].branch,
            Some("feature/saved-tab".to_string())
        );
        assert_eq!(
            metadata[0].repository_id,
            Some(std::fs::canonicalize(main_git).unwrap().to_string_lossy().to_string())
        );
        assert_eq!(
            metadata[0].repository_name,
            Some("project".to_string())
        );
    }

    #[test]
    fn separate_repositories_use_different_identities() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        fs::create_dir_all(first.join(".git")).unwrap();
        fs::create_dir_all(second.join(".git")).unwrap();

        let first_info = get_repository_info(&first).unwrap();
        let second_info = get_repository_info(&second).unwrap();

        assert_ne!(first_info.0, second_info.0);
        assert_eq!(first_info.1, "first");
        assert_eq!(second_info.1, "second");
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
    fn unsupported_editor_has_no_global_storage_file() {
        assert!(get_global_storage_file("zed").is_none());
    }

    #[test]
    fn global_storage_file_is_resolved_for_known_editors() {
        let cursor_file = get_global_storage_file("cursor").unwrap();
        assert!(cursor_file.to_string_lossy().contains("Cursor"));
        assert!(cursor_file.ends_with("globalStorage/storage.json"));

        let vscode_file = get_global_storage_file("vscode").unwrap();
        assert!(vscode_file.to_string_lossy().contains("Code"));
        assert!(vscode_file.ends_with("globalStorage/storage.json"));
    }

    #[test]
    fn current_open_workspace_paths_are_parsed() {
        let json = serde_json::json!({
            "windowsState": {
                "lastActiveWindow": {
                    "folder": "file:///worktrees/two/sample%20project"
                },
                "openedWindows": [
                    { "folder": "file:///worktrees/one/sample%20project" },
                    { "backupPath": "/tmp/empty-window" },
                    { "folder": "file:///worktrees/two/sample%20project" }
                ]
            }
        });

        let (active_path, all_paths) = parse_open_workspace_paths(&json);

        assert_eq!(
            active_path,
            Some(PathBuf::from("/worktrees/two/sample project"))
        );
        assert_eq!(
            all_paths,
            vec![
                PathBuf::from("/worktrees/one/sample project"),
                PathBuf::from("/worktrees/two/sample project"),
            ]
        );
    }

    #[test]
    fn active_workspace_is_not_treated_as_open_until_opened_windows_updates() {
        let json = serde_json::json!({
            "windowsState": {
                "lastActiveWindow": { "folder": "file:///projects/active" },
                "openedWindows": []
            }
        });

        let (active_path, all_paths) = parse_open_workspace_paths(&json);

        assert_eq!(active_path, Some(PathBuf::from("/projects/active")));
        assert!(all_paths.is_empty());
    }

    #[test]
    fn single_remaining_workspace_is_selected() {
        let candidates = vec![
            PathBuf::from("/worktrees/one/project"),
            PathBuf::from("/worktrees/two/project"),
        ];
        let assigned = vec![PathBuf::from("/worktrees/one/project")];

        assert_eq!(
            single_unassigned_workspace_path(&candidates, &assigned, 1),
            Some(PathBuf::from("/worktrees/two/project"))
        );
    }

    #[test]
    fn ambiguous_workspaces_are_not_guessed() {
        let candidates = vec![
            PathBuf::from("/worktrees/one/project"),
            PathBuf::from("/worktrees/two/project"),
        ];

        assert_eq!(single_unassigned_workspace_path(&candidates, &[], 2), None);
    }

    #[test]
    fn sole_candidate_is_not_assigned_to_one_of_multiple_windows() {
        let candidates = vec![PathBuf::from("/projects/project")];

        assert_eq!(single_unassigned_workspace_path(&candidates, &[], 2), None);
    }

    #[test]
    fn active_window_replaces_duplicate_cached_assignment() {
        let config = EditorConfig {
            id: "cache-test",
            display_name: "Sample Editor",
            bundle_id: "com.example.editor",
            app_name: "Sample Editor",
        };
        let first_path = PathBuf::from("/worktrees/one/project");
        let second_path = PathBuf::from("/worktrees/two/project");
        cache_window_path(config.id, 1, "project", &first_path);
        cache_window_path(config.id, 2, "project", &first_path);

        let workspace_state = OpenWorkspaceState {
            is_available: true,
            active_path: Some(second_path.clone()),
            all_paths: vec![first_path.clone(), second_path.clone()],
            paths_by_name: HashMap::from([(
                "project".to_string(),
                vec![first_path.clone(), second_path.clone()],
            )]),
        };
        let windows = vec![
            (1, "project — Sample Editor".to_string(), false),
            (2, "project — Sample Editor".to_string(), true),
        ];

        prepare_window_path_resolution(&config, &windows, &workspace_state);

        let cache = WINDOW_PATH_CACHE.lock().unwrap();
        assert_eq!(
            cache.get(&(config.id.to_string(), 1, "project".to_string())),
            Some(&first_path)
        );
        assert_eq!(
            cache.get(&(config.id.to_string(), 2, "project".to_string())),
            Some(&second_path)
        );
    }

    #[test]
    fn workspace_path_matches_document_in_same_named_worktree() {
        let candidates = vec![
            PathBuf::from("/worktrees/one/project"),
            PathBuf::from("/worktrees/two/project"),
        ];
        let document = PathBuf::from("/worktrees/two/project/modules/api/src/lib.rs");

        assert_eq!(
            workspace_path_for_document(&candidates, &document),
            Some(PathBuf::from("/worktrees/two/project"))
        );
    }
}
