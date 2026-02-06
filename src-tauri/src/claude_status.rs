use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

static STATUS_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);
static WATCHER_PAUSED: AtomicBool = AtomicBool::new(false);

const CLAUDE_WAITING_FILE: &str = "/tmp/claude-code-waiting";
const SESSION_READ_TIMEOUT_SECS: u64 = 60; // この秒数以上更新がないセッションは読まない

/// Claude Code の状態
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeStatus {
    Waiting,
    Generating,
}

/// セッションファイルから読み取った状態
#[derive(Clone, Debug, PartialEq, Eq)]
enum SessionState {
    Generating,  // 生成中（user, progress, assistant without tool_use, system）
    ToolPending, // tool_use 出力済み（承認待ち or 自動実行待ち）
    Inactive,    // 完了（stop_hook_summary, turn_duration, etc.）
}

/// フロントエンドに送信するペイロード
#[derive(Clone, Serialize)]
pub struct ClaudeStatusPayload {
    pub statuses: HashMap<String, ClaudeStatus>,
}

/// history.jsonl のエントリ構造（必要なフィールドのみ）
#[derive(Deserialize)]
struct HistoryEntry {
    project: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: String,
}

/// Claude のホームディレクトリを取得
fn get_claude_home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// /tmp/claude-code-waiting から待機中のプロジェクトパスを取得
fn get_waiting_projects() -> HashSet<String> {
    let path = Path::new(CLAUDE_WAITING_FILE);
    if !path.exists() {
        return HashSet::new();
    }

    match fs::read_to_string(path) {
        Ok(content) => content
            .lines()
            .map(|line| {
                let trimmed = line.trim();
                trimmed.strip_suffix('/').unwrap_or(trimmed).to_string()
            })
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => HashSet::new(),
    }
}

/// セッションデータ（アクティブセッションと全プロジェクトパスを分離）
struct SessionData {
    /// 最近更新されたセッションのみ（Generating チェック用）
    active_sessions: HashMap<String, Vec<PathBuf>>,
    /// 全プロジェクトパス（normalize_cwd_to_project_path 用）
    all_project_paths: Vec<String>,
}

/// history.jsonl からセッション情報を取得
/// デデュプ後にフィルタすることで stat() の重複呼び出しを防ぐ
fn get_session_data() -> SessionData {
    let claude_home = match get_claude_home() {
        Some(h) => h,
        None => {
            return SessionData {
                active_sessions: HashMap::new(),
                all_project_paths: Vec::new(),
            }
        }
    };

    let history_path = claude_home.join("history.jsonl");
    if !history_path.exists() {
        return SessionData {
            active_sessions: HashMap::new(),
            all_project_paths: Vec::new(),
        };
    }

    let content = match fs::read_to_string(&history_path) {
        Ok(c) => c,
        Err(_) => {
            return SessionData {
                active_sessions: HashMap::new(),
                all_project_paths: Vec::new(),
            }
        }
    };

    // Step 1: デデュプしながら全セッション収集（stat なし）
    let mut all_sessions: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut all_project_paths_set: HashSet<String> = HashSet::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(entry) = serde_json::from_str::<HistoryEntry>(line) {
            let project = match &entry.project {
                Some(p) => p,
                None => continue,
            };

            let normalized_path = project.strip_suffix('/').unwrap_or(project);
            // Claude Code と同じエンコード（英数字・-・_ 以外を - に置換）
            let encoded_path: String = normalized_path
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
                .collect();

            let session_file = claude_home
                .join("projects")
                .join(&encoded_path)
                .join(format!("{}.jsonl", entry.session_id));

            // 全プロジェクトパスを収集（フィルタなし）
            all_project_paths_set.insert(normalized_path.to_string());

            // 同じプロジェクトに複数セッションを蓄積（重複は除外）
            let list = all_sessions.entry(normalized_path.to_string()).or_default();
            if !list.contains(&session_file) {
                list.push(session_file);
            }
        }
    }

    // Step 2: デデュプ済みセッションのみフィルタ（ユニークファイルだけ stat）
    let mut active_sessions: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for (path, session_files) in all_sessions {
        let active: Vec<PathBuf> = session_files
            .into_iter()
            .filter(|f| is_recently_updated_within(f, SESSION_READ_TIMEOUT_SECS))
            .collect();
        if !active.is_empty() {
            active_sessions.insert(path, active);
        }
    }

    SessionData {
        active_sessions,
        all_project_paths: all_project_paths_set.into_iter().collect(),
    }
}

/// セッションファイルが指定秒数以内に更新されたかどうか
fn is_recently_updated_within(session_file: &Path, timeout_secs: u64) -> bool {
    if !session_file.exists() {
        return false;
    }

    match session_file.metadata() {
        Ok(metadata) => match metadata.modified() {
            Ok(modified) => {
                let now = SystemTime::now();
                match now.duration_since(modified) {
                    Ok(duration) => duration.as_secs() < timeout_secs,
                    Err(_) => false,
                }
            }
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// ファイル末尾から最後の非空行を読み取る
/// 末尾から TAIL_BUFFER_SIZE バイトだけ読み、最後の非空行を返す
const TAIL_BUFFER_SIZE: u64 = 65536; // 64KB - 実測で最大31KBの行があるため

fn read_last_line(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let file_size = file.metadata().ok()?.len();

    if file_size == 0 {
        return None;
    }

    // ファイルサイズが小さい場合は全体を読む
    let read_size = file_size.min(TAIL_BUFFER_SIZE);
    let seek_pos = file_size - read_size;

    file.seek(SeekFrom::Start(seek_pos)).ok()?;
    let mut buf = vec![0u8; read_size as usize];
    file.read_exact(&mut buf).ok()?;

    let content = String::from_utf8_lossy(&buf);

    // 末尾から最後の非空行を取得
    content
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
}

/// セッションファイルの最後のエントリからセッション状態を判定
/// 判定ロジック（コンテンツベース、時間チェック不要）:
/// - type: "system", subtype: "stop_hook_summary" | "turn_duration" → Inactive（明示的完了）
/// - type: "assistant" + content に tool_use あり → ToolPending（承認待ち or 自動実行待ち）
/// - type: "assistant" + content に tool_use なし → Generating（テキスト/thinking 生成中）
/// - type: "user" | "progress" → Generating（ツール実行中 or 応答開始）
/// - type: "system" (その他) → Generating（生成中）
/// - それ以外 (file-history-snapshot, summary 等) → Inactive
///   SESSION_READ_TIMEOUT_SECS のみクラッシュ時のセーフティネットとして残す
fn get_session_state(session_file: &Path) -> SessionState {
    // セーフティネット: 一定時間以上更新がないセッションは読まない（クラッシュ対策）
    if !is_recently_updated_within(session_file, SESSION_READ_TIMEOUT_SECS) {
        return SessionState::Inactive;
    }

    // ファイル末尾から最後の行だけ読む（パフォーマンス最適化）
    let last_line = match read_last_line(session_file) {
        Some(l) => l,
        None => return SessionState::Inactive,
    };

    // JSON パース
    let json: serde_json::Value = match serde_json::from_str(&last_line) {
        Ok(j) => j,
        Err(_) => return SessionState::Inactive,
    };

    let entry_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let subtype = json.get("subtype").and_then(|v| v.as_str()).unwrap_or("");

    let state = match entry_type {
        // 明示的な完了シグナル → Inactive
        "system" if matches!(subtype, "stop_hook_summary" | "turn_duration") => {
            SessionState::Inactive
        }
        // assistant: tool_use を含む場合は ToolPending（承認待ち or 自動実行待ち）
        "assistant" => {
            let has_tool_use = json
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter().any(|item| {
                        item.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                    })
                })
                .unwrap_or(false);
            if has_tool_use {
                SessionState::ToolPending
            } else {
                SessionState::Generating
            }
        }
        // user, progress → 生成中（ツール実行中 or 応答開始）
        "user" | "progress" => SessionState::Generating,
        // system の他の subtype → 生成中
        "system" => SessionState::Generating,
        // file-history-snapshot, summary 等 → Inactive
        _ => SessionState::Inactive,
    };

    println!(
        "[claude_status] Session check: type={:?}, subtype={:?}, state={:?}",
        entry_type, subtype, state
    );

    state
}

/// cwd パスを history.jsonl のプロジェクトパスに正規化
/// 例: /Users/.../vscode-tab-manager/src-tauri/src → /Users/.../vscode-tab-manager
fn normalize_cwd_to_project_path(cwd: &str, project_paths: &[&String]) -> String {
    // cwd がどのプロジェクトのサブディレクトリか判定
    // 複数マッチする場合は最も長い（具体的な）パスを選択
    project_paths
        .iter()
        .filter(|p| cwd.starts_with(p.as_str()))
        .max_by_key(|p| p.len())
        .map(|p| (*p).clone())
        .unwrap_or_else(|| cwd.to_string()) // マッチしない場合は元のパスを使用
}

/// 全プロジェクトの状態を取得
/// キーはプロジェクトのフルパス（正規化済み、末尾スラッシュなし）
/// 優先度: Generating > ToolPending > Inactive
/// ToolPending の場合: waiting ファイルにあれば Waiting、なければ Generating を維持（ギャップ防止）
fn get_all_statuses() -> HashMap<String, ClaudeStatus> {
    let raw_waiting = get_waiting_projects();
    let data = get_session_data();
    let mut statuses = HashMap::new();

    let project_path_refs: Vec<&String> = data.all_project_paths.iter().collect();

    // waiting projects を正規化
    let normalized_waiting: HashSet<String> = raw_waiting
        .iter()
        .map(|cwd| normalize_cwd_to_project_path(cwd, &project_path_refs))
        .collect();

    // 各プロジェクトのセッション状態を判定
    for (path, session_files) in &data.active_sessions {
        let mut has_generating = false;
        let mut has_tool_pending = false;

        for session_file in session_files {
            match get_session_state(session_file) {
                SessionState::Generating => {
                    has_generating = true;
                    break; // 1つでも Generating なら十分
                }
                SessionState::ToolPending => {
                    has_tool_pending = true;
                }
                SessionState::Inactive => {}
            }
        }

        if has_generating {
            statuses.insert(path.clone(), ClaudeStatus::Generating);
        } else if has_tool_pending {
            // tool_use 出力済み → waiting ファイルで確認
            if normalized_waiting.contains(path) {
                statuses.insert(path.clone(), ClaudeStatus::Waiting);
            } else {
                // waiting ファイル未到着 → Generating を維持（ギャップ防止）
                statuses.insert(path.clone(), ClaudeStatus::Generating);
            }
        }
    }

    // セッションが Inactive/なし だが waiting にあるプロジェクト
    for path in &normalized_waiting {
        statuses.entry(path.clone()).or_insert(ClaudeStatus::Waiting);
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
            // 一時停止中はスリープして継続（CPU節約）
            if WATCHER_PAUSED.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(100));
                continue;
            }

            let statuses = get_all_statuses();

            // 状態が変化した場合のみイベントを送信
            if statuses != last_statuses {
                println!("[claude_status] Status changed: {:?}", statuses);
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

/// 特定のパスの通知ファイルエントリをクリア
/// path_to_clear: プロジェクトのフルパス（正規化済み、末尾スラッシュなし）
/// サブディレクトリからの cwd も正しくクリアされるよう、正規化を考慮
pub fn clear_notification_file_for_path(path_to_clear: Option<&str>) {
    let file_path = Path::new(CLAUDE_WAITING_FILE);

    // ファイルが存在しない場合は早期リターン
    if !file_path.exists() {
        return;
    }

    match path_to_clear {
        Some(clear_path) => {
            let waiting = get_waiting_projects();
            let normalized_clear = clear_path.strip_suffix('/').unwrap_or(clear_path);

            // プロジェクトパスのプレフィックスにマッチするエントリも削除
            // 例: clear_path="/Users/.../vscode-tab-manager" の場合
            //     "/Users/.../vscode-tab-manager/src-tauri/src" も削除対象
            let remaining: Vec<_> = waiting
                .into_iter()
                .filter(|cwd| {
                    // 完全一致: cwd == clear_path
                    // サブディレクトリ: cwd.starts_with(clear_path + "/")
                    cwd != normalized_clear && !cwd.starts_with(&format!("{}/", normalized_clear))
                })
                .collect();

            if remaining.is_empty() {
                let _ = fs::remove_file(file_path);
            } else {
                let content = remaining.join("\n") + "\n";
                let _ = fs::write(file_path, content);
            }
        }
        None => {
            let _ = fs::remove_file(file_path);
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
