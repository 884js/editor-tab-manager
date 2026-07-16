//! Central window registry - single source of truth for editor windows.
//!
//! AX events, app activation, and startup all funnel through `request_refresh()`.
//! The registry pulls a fresh list via `editor::get_all_editor_window_snapshot()`, diffs
//! against the last snapshot, and emits `windows:snapshot` only when something
//! actually changed.
//!
//! The registry also owns the "no windows yet" retries:
//! - **transient-empty retry**: if AX returns empty while editors are still
//!   running, re-query after a brief pause before believing the empty result.
//! - **cold-start retry**: after a refresh leaves the registry empty while an
//!   editor is running, the same worker performs a few more attempts.

use crate::editor::EditorWindow;
use crate::editor_config::EDITORS;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct WindowsSnapshot {
    pub revision: u64,
    pub windows: Vec<EditorWindow>,
    pub active_id: Option<u32>,
    pub source: String,
}

struct RegistryState {
    revision: u64,
    windows: Vec<EditorWindow>,
    active_id: Option<u32>,
    /// Last-seen PID per editor_id. Used to detect editor restarts so we can
    /// invalidate editor.rs's workspace.json cache for the restarted editor.
    editor_pids: HashMap<String, i32>,
    app_handle: Option<AppHandle>,
    refresh_tx: Option<Sender<String>>,
}

lazy_static::lazy_static! {
    static ref REGISTRY: Mutex<RegistryState> = Mutex::new(RegistryState {
        revision: 0,
        windows: Vec::new(),
        active_id: None,
        editor_pids: HashMap::new(),
        app_handle: None,
        refresh_tx: None,
    });
}

const COLD_START_RETRIES: u32 = 6;
const COLD_START_INTERVAL_MS: u64 = 500;
const TRANSIENT_EMPTY_RECHECK_MS: u64 = 150;

/// Initialize the registry with the Tauri AppHandle. Called once at startup.
pub fn init(app_handle: AppHandle) {
    let (refresh_tx, refresh_rx) = mpsc::channel::<String>();
    {
        let mut state = REGISTRY.lock().expect("registry mutex poisoned");
        state.app_handle = Some(app_handle);
        state.refresh_tx = Some(refresh_tx);
    }
    thread::spawn(move || run_refresh_worker(refresh_rx));
}

fn run_refresh_worker(refresh_rx: Receiver<String>) {
    while let Ok(mut source) = refresh_rx.recv() {
        while let Ok(next_source) = refresh_rx.try_recv() {
            source = next_source;
        }
        refresh_sync(&source);

        if has_current_windows() || !any_editor_running() {
            continue;
        }
        for _ in 0..COLD_START_RETRIES {
            thread::sleep(Duration::from_millis(COLD_START_INTERVAL_MS));
            if !any_editor_running() {
                break;
            }
            source = "cold-start-retry".to_string();
            while let Ok(next_source) = refresh_rx.try_recv() {
                source = next_source;
            }
            refresh_sync(&source);
            if has_current_windows() {
                break;
            }
        }
    }
}

/// Return the currently cached snapshot.
pub fn snapshot() -> WindowsSnapshot {
    let state = REGISTRY.lock().expect("registry mutex poisoned");
    WindowsSnapshot {
        revision: state.revision,
        windows: state.windows.clone(),
        active_id: state.active_id,
        source: "snapshot".to_string(),
    }
}

/// Request an async refresh. The AX query + diff + emit runs on a background
/// thread so callers (main thread AX observer callbacks, notification blocks)
/// do not block. Cold-start retries run on that same worker.
pub fn request_refresh(source: &str) {
    let refresh_tx = REGISTRY
        .lock()
        .expect("registry mutex poisoned")
        .refresh_tx
        .clone();
    if let Some(refresh_tx) = refresh_tx {
        let _ = refresh_tx.send(source.to_string());
    }
}

/// Synchronous refresh. Runs the AX query on the calling thread. Returns true
/// if the cached snapshot was updated.
pub fn refresh_sync(source: &str) -> bool {
    // Detect editor restarts and invalidate stale workspace.json caches before
    // re-reading window metadata.
    reconcile_editor_pids();

    let (new_windows, new_active) = crate::editor::get_all_editor_window_snapshot();

    // Transient-empty guard: if AX returned no windows but we previously had
    // some and an editor is still running, treat this as a flicker and re-
    // query after a brief pause before believing the empty result.
    if new_windows.is_empty() && has_current_windows() && any_editor_running() {
        thread::sleep(Duration::from_millis(TRANSIENT_EMPTY_RECHECK_MS));
        let (rechecked, rechecked_active) = crate::editor::get_all_editor_window_snapshot();
        if !rechecked.is_empty() {
            return apply_snapshot(rechecked, rechecked_active, source);
        }
    }

    apply_snapshot(new_windows, new_active, source)
}

fn apply_snapshot(
    new_windows: Vec<EditorWindow>,
    new_active_id: Option<u32>,
    source: &str,
) -> bool {
    let (app_handle, revision) = {
        let mut state = REGISTRY.lock().expect("registry mutex poisoned");
        if !windows_differ(&state.windows, &new_windows) && state.active_id == new_active_id {
            return false;
        }
        state.revision = state.revision.wrapping_add(1);
        state.windows = new_windows.clone();
        state.active_id = new_active_id;
        (state.app_handle.clone(), state.revision)
    };

    if let Some(handle) = app_handle {
        if let Some(window) = handle.get_webview_window("main") {
            let payload = WindowsSnapshot {
                revision,
                windows: new_windows,
                active_id: new_active_id,
                source: source.to_string(),
            };
            let _ = window.emit("windows:snapshot", payload);
        }
    }

    true
}

fn has_current_windows() -> bool {
    !REGISTRY
        .lock()
        .expect("registry mutex poisoned")
        .windows
        .is_empty()
}

fn any_editor_running() -> bool {
    EDITORS
        .iter()
        .any(|e| crate::ax_helper::get_pid_by_bundle_id(e.bundle_id).is_some())
}

/// Compare each editor's current PID against the last-seen value. When the PID
/// changed (start, restart, or exit) invalidate that editor's path cache so a
/// fresh workspace.json read picks up any projects added/removed while the
/// editor was closed.
fn reconcile_editor_pids() {
    let mut changed: Vec<String> = Vec::new();
    {
        let mut state = REGISTRY.lock().expect("registry mutex poisoned");
        for editor in EDITORS {
            let new_pid = crate::ax_helper::get_pid_by_bundle_id(editor.bundle_id);
            let old_pid = state.editor_pids.get(editor.id).copied();
            if new_pid != old_pid {
                changed.push(editor.id.to_string());
                match new_pid {
                    Some(pid) => {
                        state.editor_pids.insert(editor.id.to_string(), pid);
                    }
                    None => {
                        state.editor_pids.remove(editor.id);
                    }
                }
            }
        }
    }
    for editor_id in &changed {
        crate::editor::invalidate_path_cache_for_editor(editor_id);
    }
}

/// Two snapshots differ when length, or any identity field (id / name / branch /
/// path / bundle_id) differs. Order is ignored — frontend reorders independently.
fn windows_differ(a: &[EditorWindow], b: &[EditorWindow]) -> bool {
    if a.len() != b.len() {
        return true;
    }

    let mut a_sorted: Vec<&EditorWindow> = a.iter().collect();
    let mut b_sorted: Vec<&EditorWindow> = b.iter().collect();
    a_sorted.sort_by_key(|window| (&window.bundle_id, window.id));
    b_sorted.sort_by_key(|window| (&window.bundle_id, window.id));

    a_sorted.iter().zip(b_sorted.iter()).any(|(wa, wb)| {
        wa.id != wb.id
            || wa.runtime_id != wb.runtime_id
            || wa.name != wb.name
            || wa.branch != wb.branch
            || wa.path != wb.path
            || wa.repository_id != wb.repository_id
            || wa.repository_name != wb.repository_name
            || wa.bundle_id != wb.bundle_id
            || wa.resolution != wb.resolution
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: u32, name: &str, bundle: &str) -> EditorWindow {
        EditorWindow {
            runtime_id: format!("{}:{}", bundle, id),
            id,
            name: name.to_string(),
            path: String::new(),
            branch: None,
            repository_id: None,
            repository_name: None,
            bundle_id: bundle.to_string(),
            editor_name: String::new(),
            resolution: crate::editor::WorkspaceResolution::Unresolved,
        }
    }

    #[test]
    fn identical_snapshots_do_not_differ() {
        let a = vec![mk(1, "alpha", "b1"), mk(2, "beta", "b1")];
        let b = vec![mk(1, "alpha", "b1"), mk(2, "beta", "b1")];
        assert!(!windows_differ(&a, &b));
    }

    #[test]
    fn name_change_is_detected() {
        let a = vec![mk(1, "alpha", "b1")];
        let b = vec![mk(1, "renamed", "b1")];
        assert!(windows_differ(&a, &b));
    }

    #[test]
    fn reordering_is_not_a_difference() {
        let a = vec![mk(1, "alpha", "b1"), mk(2, "beta", "b1")];
        let b = vec![mk(2, "beta", "b1"), mk(1, "alpha", "b1")];
        assert!(!windows_differ(&a, &b));
    }

    #[test]
    fn reordering_across_editors_with_same_window_id_is_not_a_difference() {
        let a = vec![mk(1, "alpha", "b1"), mk(1, "beta", "b2")];
        let b = vec![mk(1, "beta", "b2"), mk(1, "alpha", "b1")];
        assert!(!windows_differ(&a, &b));
    }

    #[test]
    fn length_change_is_detected() {
        let a = vec![mk(1, "alpha", "b1")];
        let b = vec![mk(1, "alpha", "b1"), mk(2, "beta", "b1")];
        assert!(windows_differ(&a, &b));
    }

    #[test]
    fn branch_change_is_detected() {
        let a = vec![EditorWindow {
            runtime_id: "b1:1".into(),
            id: 1,
            name: "p".into(),
            path: String::new(),
            branch: Some("main".into()),
            repository_id: None,
            repository_name: None,
            bundle_id: "b1".into(),
            editor_name: String::new(),
            resolution: crate::editor::WorkspaceResolution::Unresolved,
        }];
        let b = vec![EditorWindow {
            runtime_id: "b1:1".into(),
            id: 1,
            name: "p".into(),
            path: String::new(),
            branch: Some("dev".into()),
            repository_id: None,
            repository_name: None,
            bundle_id: "b1".into(),
            editor_name: String::new(),
            resolution: crate::editor::WorkspaceResolution::Unresolved,
        }];
        assert!(windows_differ(&a, &b));
    }

    #[test]
    fn repository_identity_change_is_detected() {
        let a = vec![mk(1, "project", "b1")];
        let mut resolved = mk(1, "project", "b1");
        resolved.repository_id = Some("/projects/project/.git".into());
        resolved.repository_name = Some("project".into());

        assert!(windows_differ(&a, &[resolved]));
    }
}
