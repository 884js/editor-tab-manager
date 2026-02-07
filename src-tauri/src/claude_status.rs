use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static STATUS_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

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

/// 1行をパースして状態マップを更新する。状態が変化した場合は true を返す。
fn apply_line(line: &str, statuses: &mut HashMap<String, ClaudeStatus>) -> bool {
    let trimmed = line.trim();
    if trimmed.len() < 3 {
        return false;
    }

    let prefix = &trimmed[..1];
    let project = trimmed[2..].trim_end_matches('/');

    if project.is_empty() {
        return false;
    }

    match prefix {
        "g" => {
            let prev = statuses.insert(project.to_string(), ClaudeStatus::Generating);
            prev.as_ref() != Some(&ClaudeStatus::Generating)
        }
        "w" => {
            let prev = statuses.insert(project.to_string(), ClaudeStatus::Waiting);
            prev.as_ref() != Some(&ClaudeStatus::Waiting)
        }
        "c" => statuses.remove(project).is_some(),
        _ => false,
    }
}

/// 状態監視ウォッチャーを開始（差分読み取り方式）
pub fn start_claude_status_watcher(app_handle: AppHandle) {
    if STATUS_WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    // ウォッチャー開始前に古いイベントログをクリア
    let _ = fs::remove_file(CLAUDE_EVENTS_FILE);

    thread::spawn(move || {
        let mut current_statuses: HashMap<String, ClaudeStatus> = HashMap::new();
        let mut last_offset: u64 = 0;

        while STATUS_WATCHER_RUNNING.load(Ordering::SeqCst) {
            let path = Path::new(CLAUDE_EVENTS_FILE);

            if let Ok(metadata) = fs::metadata(path) {
                let file_size = metadata.len();

                // ファイルが切り詰められた場合はリセット
                if file_size < last_offset {
                    last_offset = 0;
                    current_statuses.clear();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let payload = ClaudeStatusPayload {
                            statuses: current_statuses.clone(),
                        };
                        let _ = window.emit("claude-status", payload);
                    }
                }

                // 新しいデータがある場合のみ処理
                if file_size > last_offset {
                    if let Ok(mut file) = File::open(path) {
                        if file.seek(SeekFrom::Start(last_offset)).is_ok() {
                            let reader = BufReader::new(file);

                            for line in reader.lines().map_while(Result::ok) {
                                let changed = apply_line(&line, &mut current_statuses);
                                if changed {
                                    if let Some(window) =
                                        app_handle.get_webview_window("main")
                                    {
                                        let payload = ClaudeStatusPayload {
                                            statuses: current_statuses.clone(),
                                        };
                                        let _ = window.emit("claude-status", &payload);
                                    }
                                }
                            }
                        }
                        last_offset = file_size;
                    }
                }
            } else {
                // ファイルが消えた場合
                if !current_statuses.is_empty() {
                    current_statuses.clear();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let payload = ClaudeStatusPayload {
                            statuses: current_statuses.clone(),
                        };
                        let _ = window.emit("claude-status", payload);
                    }
                }
                last_offset = 0;
            }

            thread::sleep(Duration::from_millis(300));
        }
    });
}

/// 状態監視ウォッチャーを停止
#[allow(dead_code)]
pub fn stop_claude_status_watcher() {
    STATUS_WATCHER_RUNNING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
#[path = "claude_status_tests.rs"]
mod tests;
