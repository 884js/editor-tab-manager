//! Window offset management module
//!
//! Manages automatic window offset when the tab bar is visible to prevent
//! editor UI elements (like search bars) from being hidden behind the tab bar.

use crate::ax_helper;
use objc2::MainThreadMarker;
use objc2_app_kit::NSScreen;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

/// Get the file path for storing original window positions
/// Uses ~/Library/Application Support/ instead of /tmp for security
fn get_offset_file_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let dir = PathBuf::from(&home).join("Library/Application Support/com.editor-tab-manager.app");
    let _ = fs::create_dir_all(&dir);
    dir.join("offsets.json")
}

/// Window frame data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Stored window positions keyed by bundle_id -> window_id -> frame
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct OffsetStore {
    /// bundle_id -> (window_id -> original_frame)
    pub positions: HashMap<String, HashMap<u32, WindowFrame>>,
}

/// Global store for original window positions
static OFFSET_STORE: LazyLock<Mutex<OffsetStore>> = LazyLock::new(|| {
    // Try to load from file on startup
    let store = load_from_file().unwrap_or_default();
    Mutex::new(store)
});

/// Load offset store from temporary file
fn load_from_file() -> Option<OffsetStore> {
    let content = fs::read_to_string(get_offset_file_path()).ok()?;
    serde_json::from_str(&content).ok()
}

/// Save offset store to temporary file
fn save_to_file(store: &OffsetStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize offset store: {}", e))?;
    fs::write(get_offset_file_path(), content)
        .map_err(|e| format!("Failed to write offset file: {}", e))?;
    Ok(())
}

/// Delete the temporary offset file
fn delete_offset_file() {
    let _ = fs::remove_file(get_offset_file_path());
}

/// プライマリディスプレイのサイズを取得
/// NSScreen::screens() の最初の要素が常にプライマリディスプレイ
/// (NSScreen::mainScreen はフォーカス中ウィンドウのスクリーンを返すため不適切)
fn get_primary_screen_size() -> Option<(f64, f64)> {
    let mtm = MainThreadMarker::new()?;
    let screens = NSScreen::screens(mtm);
    let primary = screens.firstObject()?;
    let frame = primary.frame();
    Some((frame.size.width, frame.size.height))
}

/// macOSのメニューバー高さを動的に取得
/// Notch付きMacではvisibleFrameがNotchを避けた領域を返す
fn get_menu_bar_height() -> f64 {
    // MainThreadMarkerの取得を試みる
    // GUIアプリなのでメインスレッドから呼ばれることを想定
    let Some(mtm) = MainThreadMarker::new() else {
        return 25.0; // フォールバック（メインスレッドでない場合）
    };
    // NSScreen::screens() の最初の要素が常にプライマリディスプレイ
    // (NSScreen::mainScreen はフォーカス中ウィンドウのスクリーンを返すため不適切)
    let screens = NSScreen::screens(mtm);
    let Some(primary) = screens.firstObject() else {
        return 25.0; // フォールバック
    };
    let frame = primary.frame();
    let visible_frame = primary.visibleFrame();
    // メニューバー高さ = 画面全体の高さ - 可視領域の高さ - 可視領域のY位置
    // (Dockが下にある場合、visible_frame.origin.yがDock分だけ上にずれる)
    let menu_bar_height = frame.size.height - visible_frame.size.height - visible_frame.origin.y;
    menu_bar_height.max(0.0)
}

/// Calculate the maximize frame in AX coordinates (origin top-left, Y down)
/// Returns (x, y, width, height) accounting for menu bar, tab bar, and Dock
fn get_maximize_frame(tab_bar_height: f64) -> Result<(f64, f64, f64, f64), String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "Not on main thread".to_string())?;
    let screens = NSScreen::screens(mtm);
    let primary = screens.firstObject()
        .ok_or_else(|| "No primary screen found".to_string())?;

    let frame = primary.frame();
    let visible = primary.visibleFrame();

    // menu_bar_height: macOS coords → AX coords conversion
    let menu_bar_height = (frame.size.height - visible.size.height - visible.origin.y).max(0.0);

    let ax_x = visible.origin.x;
    let ax_y = menu_bar_height + tab_bar_height;
    let width = visible.size.width;
    let height = visible.size.height - tab_bar_height;

    if height < 100.0 || width < 100.0 {
        return Err("Calculated maximize frame too small".to_string());
    }

    Ok((ax_x, ax_y, width, height))
}

/// Maximize a specific window to fill the visible area below the tab bar
pub fn maximize_window(bundle_id: &str, window_id: u32, tab_bar_height: f64) -> Result<(), String> {
    let pid = ax_helper::get_pid_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Editor not running: {}", bundle_id))?;

    // Skip fullscreen or minimized windows
    if ax_helper::is_window_fullscreen_by_id(pid, window_id).unwrap_or(false) {
        return Ok(());
    }
    if ax_helper::is_window_minimized_by_id(pid, window_id).unwrap_or(false) {
        return Ok(());
    }

    let (ax_x, ax_y, width, height) = get_maximize_frame(tab_bar_height)?;
    ax_helper::set_window_frame_by_id(pid, window_id, ax_x, ax_y, width, height)
}

/// Apply window offset for all windows of the specified editor
///
/// This function:
/// 1. Gets all windows for the editor by bundle_id
/// 2. Saves original positions (if not already saved)
/// 3. Moves windows down by TAB_BAR_HEIGHT if they're at Y < TAB_BAR_HEIGHT
pub fn apply_offset(bundle_id: &str, offset_y: f64) -> Result<(), String> {
    let pid = ax_helper::get_pid_by_bundle_id(bundle_id)
        .ok_or_else(|| format!("Editor not running: {}", bundle_id))?;

    let windows = ax_helper::get_all_window_frames(pid)?;

    if windows.is_empty() {
        return Ok(());
    }

    let mut store = OFFSET_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
    let editor_positions = store.positions.entry(bundle_id.to_string()).or_default();

    // プライマリモニターのサイズを取得（セカンダリモニター上のウィンドウをスキップするため）
    // 取得失敗時はフィルタなしで従来通り動作
    let primary_screen = get_primary_screen_size();

    for (window_id, x, y, width, height) in windows.iter() {
        // セカンダリモニター上のウィンドウはスキップ
        // AXPositionはグローバル座標系（プライマリモニター左上が原点、Y下向き正）
        if let Some((screen_w, screen_h)) = primary_screen {
            if *x < 0.0 || *x >= screen_w || *y < 0.0 || *y >= screen_h {
                continue;
            }
        }

        // Check if window is minimized or fullscreen - skip if so
        if ax_helper::is_window_minimized_by_id(pid, *window_id).unwrap_or(false) {
            continue;
        }
        if ax_helper::is_window_fullscreen_by_id(pid, *window_id).unwrap_or(false) {
            continue;
        }

        // タブバーとの重なり判定
        // メニューバー高さを動的に取得（Notch付きMac対応）
        // タブバーの下端位置 = メニューバー + タブバー高さ
        let menu_bar_height = get_menu_bar_height();
        let tab_bar_bottom = menu_bar_height + offset_y;

        // ウィンドウ上端がタブバー下端より上にあれば「重なっている」→移動対象
        // ウィンドウ上端がタブバー下端以下（>=）であれば「重なっていない」→スキップ
        if *y >= tab_bar_bottom {
            continue;
        }

        // 既にオフセットが適用済みかチェック（二重適用防止）
        // 一度オフセットを適用したウィンドウは restore_positions() が呼ばれるまで再適用しない
        if editor_positions.contains_key(window_id) {
            continue;
        }

        // Save original position
        editor_positions.insert(
            *window_id,
            WindowFrame {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            },
        );

        // Apply offset: 実際の必要量を計算（macOSが部分的に調整済みの場合に対応）
        let actual_offset = tab_bar_bottom - y;
        let new_y = y + actual_offset;
        let new_height = height - actual_offset;

        // Only apply if the new height is still reasonable
        const MIN_WINDOW_HEIGHT: f64 = 100.0;
        if new_height > MIN_WINDOW_HEIGHT {
            let _ = ax_helper::set_window_frame_by_id(pid, *window_id, *x, new_y, *width, new_height);
        }
    }

    // Save to file for crash recovery
    if let Err(e) = save_to_file(&store) {
        eprintln!("Failed to save offset file: {}", e);
    }

    Ok(())
}

/// Restore original window positions for the specified editor
pub fn restore_positions(bundle_id: &str) -> Result<(), String> {
    let mut store = OFFSET_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;

    let editor_positions = match store.positions.get(bundle_id) {
        Some(positions) if !positions.is_empty() => positions.clone(),
        _ => return Ok(()), // Nothing to restore
    };

    let pid = match ax_helper::get_pid_by_bundle_id(bundle_id) {
        Some(p) => p,
        None => {
            // Editor not running, just clear the stored positions
            store.positions.remove(bundle_id);
            if store.positions.is_empty() {
                delete_offset_file();
            } else if let Err(e) = save_to_file(&store) {
                eprintln!("Failed to save offset file: {}", e);
            }
            return Ok(());
        }
    };

    let current_windows = ax_helper::get_all_window_frames(pid)?;

    // Restore each window to its original position
    for (current_wid, _, _, _, _) in current_windows.iter() {
        if let Some(original) = editor_positions.get(current_wid) {
            // Check if window is minimized or fullscreen - skip if so
            if ax_helper::is_window_minimized_by_id(pid, *current_wid).unwrap_or(false) {
                continue;
            }
            if ax_helper::is_window_fullscreen_by_id(pid, *current_wid).unwrap_or(false) {
                continue;
            }

            if let Err(e) = ax_helper::set_window_frame_by_id(
                pid,
                *current_wid,
                original.x,
                original.y,
                original.width,
                original.height,
            ) {
                eprintln!("Failed to restore window frame for window_id={}: {}", current_wid, e);
            }
        }
    }

    // Clear stored positions for this editor
    store.positions.remove(bundle_id);

    // Update or delete the file
    if store.positions.is_empty() {
        delete_offset_file();
    } else if let Err(e) = save_to_file(&store) {
        eprintln!("Failed to save offset file: {}", e);
    }

    Ok(())
}

/// Restore all pending window positions (called on app startup for crash recovery)
pub fn restore_all_pending() -> Result<(), String> {
    let store = load_from_file();

    if let Some(store) = store {
        for bundle_id in store.positions.keys() {
            if let Err(e) = restore_positions(bundle_id) {
                eprintln!("Failed to restore positions for {}: {}", bundle_id, e);
            }
        }
    }

    // Clean up the file
    delete_offset_file();

    Ok(())
}

/// Check if there are any pending restorations
pub fn has_pending_restorations() -> bool {
    get_offset_file_path().exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_and_deserialize_offset_store() {
        let mut store = OffsetStore::default();
        let mut windows = HashMap::new();
        windows.insert(
            12345u32,
            WindowFrame {
                x: 0.0,
                y: 25.0,
                width: 1920.0,
                height: 1080.0,
            },
        );
        store
            .positions
            .insert("com.microsoft.VSCode".to_string(), windows);

        let json = serde_json::to_string_pretty(&store).unwrap();
        let deserialized: OffsetStore = serde_json::from_str(&json).unwrap();

        let positions = deserialized.positions.get("com.microsoft.VSCode").unwrap();
        let frame = positions.get(&12345u32).unwrap();
        assert_eq!(frame.x, 0.0);
        assert_eq!(frame.y, 25.0);
        assert_eq!(frame.width, 1920.0);
        assert_eq!(frame.height, 1080.0);
    }

    #[test]
    fn deserialize_old_string_key_format_fails_gracefully() {
        // 旧フォーマット（Stringキー）のJSONをデシリアライズするとpanicせずエラーになる
        let json = r#"{
            "positions": {
                "com.microsoft.VSCode": {
                    "main.rs — my-project": {
                        "x": 0.0,
                        "y": 25.0,
                        "width": 1920.0,
                        "height": 1080.0
                    }
                }
            }
        }"#;

        // 数値でないStringキーはu32にデシリアライズできないのでエラーになる
        let result: Result<OffsetStore, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn multiple_editors_and_windows() {
        let mut store = OffsetStore::default();

        let mut vscode_windows = HashMap::new();
        vscode_windows.insert(
            100u32,
            WindowFrame { x: 0.0, y: 25.0, width: 960.0, height: 1080.0 },
        );
        vscode_windows.insert(
            200u32,
            WindowFrame { x: 960.0, y: 25.0, width: 960.0, height: 1080.0 },
        );
        store.positions.insert("com.microsoft.VSCode".to_string(), vscode_windows);

        let mut cursor_windows = HashMap::new();
        cursor_windows.insert(
            300u32,
            WindowFrame { x: 0.0, y: 25.0, width: 1920.0, height: 1080.0 },
        );
        store.positions.insert("com.todesktop.230313mzl4w4u92".to_string(), cursor_windows);

        let json = serde_json::to_string(&store).unwrap();
        let deserialized: OffsetStore = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.positions.len(), 2);
        assert_eq!(deserialized.positions.get("com.microsoft.VSCode").unwrap().len(), 2);
        assert_eq!(
            deserialized.positions.get("com.todesktop.230313mzl4w4u92").unwrap().get(&300u32).unwrap().width,
            1920.0
        );
    }
}
