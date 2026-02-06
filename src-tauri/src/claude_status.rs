use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static STATUS_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);
static WATCHER_PAUSED: AtomicBool = AtomicBool::new(false);

const CLAUDE_EVENTS_FILE: &str = "/tmp/claude-code-events";

/// Claude Code の状態
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeStatus {
    Waiting,
    Generating,
}

/// フロントエンドに送信するペイロード
#[derive(Clone, Serialize)]
pub struct ClaudeStatusPayload {
    pub statuses: HashMap<String, ClaudeStatus>,
}

/// イベントファイルを読み、last-event-wins で各プロジェクトの状態を返す
fn get_all_statuses() -> HashMap<String, ClaudeStatus> {
    let path = Path::new(CLAUDE_EVENTS_FILE);
    if !path.exists() {
        return HashMap::new();
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };

    let mut statuses = HashMap::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.len() < 3 {
            continue;
        }

        let prefix = &trimmed[..1];
        let project = trimmed[2..].trim_end_matches('/');

        if project.is_empty() {
            continue;
        }

        match prefix {
            "g" => {
                statuses.insert(project.to_string(), ClaudeStatus::Generating);
            }
            "w" => {
                statuses.insert(project.to_string(), ClaudeStatus::Waiting);
            }
            "c" => {
                statuses.remove(project);
            }
            _ => {}
        }
    }

    statuses
}

/// 状態監視ウォッチャーを開始
pub fn start_claude_status_watcher(app_handle: AppHandle) {
    if STATUS_WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::spawn(move || {
        let mut last_statuses: HashMap<String, ClaudeStatus> = HashMap::new();

        while STATUS_WATCHER_RUNNING.load(Ordering::SeqCst) {
            if WATCHER_PAUSED.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(100));
                continue;
            }

            let statuses = get_all_statuses();

            if statuses != last_statuses {
                last_statuses = statuses.clone();

                if let Some(window) = app_handle.get_webview_window("main") {
                    let payload = ClaudeStatusPayload { statuses };
                    let _ = window.emit("claude-status", payload);
                }
            }

            thread::sleep(Duration::from_millis(500));
        }
    });
}

/// 特定のパスのバッジをクリア（イベントファイルに `c` を追記）
pub fn clear_notification_file_for_path(path_to_clear: Option<&str>) {
    match path_to_clear {
        Some(clear_path) => {
            let normalized = clear_path.strip_suffix('/').unwrap_or(clear_path);
            let entry = format!("c {}\n", normalized);
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(CLAUDE_EVENTS_FILE)
            {
                let _ = file.write_all(entry.as_bytes());
            }
        }
        None => {
            let _ = fs::remove_file(CLAUDE_EVENTS_FILE);
        }
    }
}

/// 状態監視ウォッチャーを停止
#[allow(dead_code)]
pub fn stop_claude_status_watcher() {
    STATUS_WATCHER_RUNNING.store(false, Ordering::SeqCst);
}

/// ウォッチャーを一時停止（タブバー非表示時のCPU最適化）
pub fn pause_watcher() {
    WATCHER_PAUSED.store(true, Ordering::SeqCst);
}

/// ウォッチャーを再開
pub fn resume_watcher() {
    WATCHER_PAUSED.store(false, Ordering::SeqCst);
}
