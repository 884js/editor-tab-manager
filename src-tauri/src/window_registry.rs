//! Central window registry - single source of truth for editor windows.
//!
//! AX events, app activation, and startup all funnel through `request_refresh()`.
//! The registry pulls a fresh list via `editor::get_all_editor_windows()`, diffs
//! against the last snapshot, and emits `windows:snapshot` only when something
//! actually changed.
//!
//! The registry also owns the "no windows yet" retries:
//! - **transient-empty retry**: if AX returns empty while editors are still
//!   running, re-query after a brief pause before believing the empty result.
//! - **cold-start retry**: after a refresh leaves the registry empty while an
//!   editor is running, schedule a few more attempts. At most one chain runs
//!   at a time (guarded by `COLD_START_RETRY_BUSY`).

use crate::editor::EditorWindow;
use crate::editor_config::EDITORS;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct WindowsSnapshot {
    pub windows: Vec<EditorWindow>,
    pub active_id: Option<u32>,
    pub source: String,
}

struct RegistryState {
    windows: Vec<EditorWindow>,
    active_id: Option<u32>,
    /// Last-seen PID per editor_id. Used to detect editor restarts so we can
    /// invalidate editor.rs's workspace.json cache for the restarted editor.
    editor_pids: HashMap<String, i32>,
    app_handle: Option<AppHandle>,
}

lazy_static::lazy_static! {
    static ref REGISTRY: Mutex<RegistryState> = Mutex::new(RegistryState {
        windows: Vec::new(),
        active_id: None,
        editor_pids: HashMap::new(),
        app_handle: None,
    });
}

static COLD_START_RETRY_BUSY: AtomicBool = AtomicBool::new(false);
const COLD_START_RETRIES: u32 = 6;
const COLD_START_INTERVAL_MS: u64 = 500;
const TRANSIENT_EMPTY_RECHECK_MS: u64 = 150;

/// Initialize the registry with the Tauri AppHandle. Called once at startup.
pub fn init(app_handle: AppHandle) {
    let mut state = REGISTRY.lock().expect("registry mutex poisoned");
    state.app_handle = Some(app_handle);
}

/// Return the currently cached snapshot.
pub fn snapshot() -> Vec<EditorWindow> {
    REGISTRY
        .lock()
        .expect("registry mutex poisoned")
        .windows
        .clone()
}

/// Request an async refresh. The AX query + diff + emit runs on a background
/// thread so callers (main thread AX observer callbacks, notification blocks)
/// do not block. A cold-start retry chain may follow if the snapshot remains
/// empty while editors are running.
pub fn request_refresh(source: &'static str) {
    thread::spawn(move || {
        refresh_sync(source);
        maybe_schedule_cold_start_retry();
    });
}

/// Synchronous refresh. Runs the AX query on the calling thread. Returns true
/// if the cached snapshot was updated.
pub fn refresh_sync(source: &str) -> bool {
    // Detect editor restarts and invalidate stale workspace.json caches before
    // re-reading window metadata.
    reconcile_editor_pids();

    let new_windows = crate::editor::get_all_editor_windows();
    let new_active = crate::editor::get_active_window_id();

    // Transient-empty guard: if AX returned no windows but we previously had
    // some and an editor is still running, treat this as a flicker and re-
    // query after a brief pause before believing the empty result.
    if new_windows.is_empty()
        && has_current_windows()
        && any_editor_running()
    {
        thread::sleep(Duration::from_millis(TRANSIENT_EMPTY_RECHECK_MS));
        let rechecked = crate::editor::get_all_editor_windows();
        if !rechecked.is_empty() {
            let rechecked_active = crate::editor::get_active_window_id();
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
    let app_handle = {
        let mut state = REGISTRY.lock().expect("registry mutex poisoned");
        if !windows_differ(&state.windows, &new_windows)
            && state.active_id == new_active_id
        {
            return false;
        }
        state.windows = new_windows.clone();
        state.active_id = new_active_id;
        state.app_handle.clone()
    };

    if let Some(handle) = app_handle {
        if let Some(window) = handle.get_webview_window("main") {
            let payload = WindowsSnapshot {
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

/// Start a cold-start retry chain if the registry is empty while editors run.
/// Exactly one chain runs at a time.
fn maybe_schedule_cold_start_retry() {
    let should_retry = {
        let state = REGISTRY.lock().expect("registry mutex poisoned");
        state.windows.is_empty()
    } && any_editor_running();

    if !should_retry {
        return;
    }
    if COLD_START_RETRY_BUSY.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::spawn(|| {
        for _ in 0..COLD_START_RETRIES {
            thread::sleep(Duration::from_millis(COLD_START_INTERVAL_MS));
            if refresh_sync("cold-start-retry") {
                break;
            }
            if !any_editor_running() {
                break;
            }
        }
        COLD_START_RETRY_BUSY.store(false, Ordering::SeqCst);
    });
}

/// Two snapshots differ when length, or any identity field (id / name / branch /
/// path / bundle_id) differs. Order is ignored — frontend reorders independently.
fn windows_differ(a: &[EditorWindow], b: &[EditorWindow]) -> bool {
    if a.len() != b.len() {
        return true;
    }

    let mut a_sorted: Vec<&EditorWindow> = a.iter().collect();
    let mut b_sorted: Vec<&EditorWindow> = b.iter().collect();
    a_sorted.sort_by_key(|w| w.id);
    b_sorted.sort_by_key(|w| w.id);

    a_sorted
        .iter()
        .zip(b_sorted.iter())
        .any(|(wa, wb)| {
            wa.id != wb.id
                || wa.name != wb.name
                || wa.branch != wb.branch
                || wa.path != wb.path
                || wa.bundle_id != wb.bundle_id
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: u32, name: &str, bundle: &str) -> EditorWindow {
        EditorWindow {
            id,
            name: name.to_string(),
            path: String::new(),
            branch: None,
            bundle_id: bundle.to_string(),
            editor_name: String::new(),
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
    fn length_change_is_detected() {
        let a = vec![mk(1, "alpha", "b1")];
        let b = vec![mk(1, "alpha", "b1"), mk(2, "beta", "b1")];
        assert!(windows_differ(&a, &b));
    }

    #[test]
    fn branch_change_is_detected() {
        let a = vec![EditorWindow {
            id: 1,
            name: "p".into(),
            path: String::new(),
            branch: Some("main".into()),
            bundle_id: "b1".into(),
            editor_name: String::new(),
        }];
        let b = vec![EditorWindow {
            id: 1,
            name: "p".into(),
            path: String::new(),
            branch: Some("dev".into()),
            bundle_id: "b1".into(),
            editor_name: String::new(),
        }];
        assert!(windows_differ(&a, &b));
    }
}
