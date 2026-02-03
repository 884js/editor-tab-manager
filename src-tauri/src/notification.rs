use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static NOTIFICATION_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

const CLAUDE_WAITING_FILE: &str = "/tmp/claude-code-waiting";

/// Payload for Claude Code notification events
#[derive(Clone, serde::Serialize)]
pub struct ClaudeNotificationPayload {
    pub waiting: bool,
    pub paths: Vec<String>,
}

/// Read waiting paths from notification file
fn read_waiting_paths() -> Vec<String> {
    let path = Path::new(CLAUDE_WAITING_FILE);
    if !path.exists() {
        return Vec::new();
    }

    match std::fs::read_to_string(path) {
        Ok(content) => {
            content
                .lines()
                .map(|line| {
                    // Normalize path: remove trailing slash
                    let trimmed = line.trim();
                    if trimmed.ends_with('/') {
                        trimmed[..trimmed.len() - 1].to_string()
                    } else {
                        trimmed.to_string()
                    }
                })
                .filter(|s| !s.is_empty())
                .collect()
        }
        Err(_) => Vec::new(),
    }
}

/// Start the notification file watcher in a background thread
pub fn start_notification_watcher(app_handle: AppHandle) {
    if NOTIFICATION_WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::spawn(move || {
        let mut last_paths: Vec<String> = Vec::new();

        while NOTIFICATION_WATCHER_RUNNING.load(Ordering::SeqCst) {
            let paths = read_waiting_paths();
            let waiting = !paths.is_empty();

            // Only emit event when paths change
            if paths != last_paths {
                last_paths = paths.clone();

                if let Some(window) = app_handle.get_webview_window("main") {
                    let payload = ClaudeNotificationPayload {
                        waiting,
                        paths,
                    };
                    let _ = window.emit("claude-notification", payload);
                }
            }

            thread::sleep(Duration::from_millis(500));
        }
    });
}

/// Clear the notification file (called when window becomes active)
/// If `path_to_clear` is provided, only remove that path from the file.
/// If `path_to_clear` is None, remove the entire file.
pub fn clear_notification_file_for_path(path_to_clear: Option<&str>) {
    let file_path = Path::new(CLAUDE_WAITING_FILE);
    if !file_path.exists() {
        return;
    }

    match path_to_clear {
        Some(clear_path) => {
            // Read current paths, remove the specified path, and write back
            let paths = read_waiting_paths();
            let normalized_clear = if clear_path.ends_with('/') {
                &clear_path[..clear_path.len() - 1]
            } else {
                clear_path
            };

            let remaining: Vec<_> = paths
                .into_iter()
                .filter(|p| {
                    // パスの末尾ディレクトリ名とウィンドウ名を比較
                    let dir_name = p.rsplit('/').next().unwrap_or("");
                    dir_name != normalized_clear
                })
                .collect();

            if remaining.is_empty() {
                let _ = std::fs::remove_file(file_path);
            } else {
                let content = remaining.join("\n") + "\n";
                let _ = std::fs::write(file_path, content);
            }
        }
        None => {
            let _ = std::fs::remove_file(file_path);
        }
    }
}

/// Clear the notification file (called when window becomes active)
#[allow(dead_code)]
pub fn clear_notification_file() {
    clear_notification_file_for_path(None);
}

/// Stop the notification watcher
#[allow(dead_code)]
pub fn stop_notification_watcher() {
    NOTIFICATION_WATCHER_RUNNING.store(false, Ordering::SeqCst);
}
