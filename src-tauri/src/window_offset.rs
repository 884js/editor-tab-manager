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
use std::sync::{LazyLock, Mutex};

/// Temporary file path for storing original window positions
const OFFSET_FILE_PATH: &str = "/tmp/editor-tab-manager-offsets.json";

/// Window frame data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Stored window positions keyed by bundle_id -> window_title -> frame
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct OffsetStore {
    /// bundle_id -> (window_title -> original_frame)
    pub positions: HashMap<String, HashMap<String, WindowFrame>>,
}

/// Global store for original window positions
static OFFSET_STORE: LazyLock<Mutex<OffsetStore>> = LazyLock::new(|| {
    // Try to load from file on startup
    let store = load_from_file().unwrap_or_default();
    Mutex::new(store)
});

/// Load offset store from temporary file
fn load_from_file() -> Option<OffsetStore> {
    let content = fs::read_to_string(OFFSET_FILE_PATH).ok()?;
    serde_json::from_str(&content).ok()
}

/// Save offset store to temporary file
fn save_to_file(store: &OffsetStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize offset store: {}", e))?;
    fs::write(OFFSET_FILE_PATH, content)
        .map_err(|e| format!("Failed to write offset file: {}", e))?;
    Ok(())
}

/// Delete the temporary offset file
fn delete_offset_file() {
    let _ = fs::remove_file(OFFSET_FILE_PATH);
}

/// macOSのメニューバー高さを動的に取得
/// Notch付きMacではvisibleFrameがNotchを避けた領域を返す
fn get_menu_bar_height() -> f64 {
    // MainThreadMarkerの取得を試みる
    // GUIアプリなのでメインスレッドから呼ばれることを想定
    let Some(mtm) = MainThreadMarker::new() else {
        return 25.0; // フォールバック（メインスレッドでない場合）
    };
    let Some(main_screen) = NSScreen::mainScreen(mtm) else {
        return 25.0; // フォールバック
    };
    let frame = main_screen.frame();
    let visible_frame = main_screen.visibleFrame();
    // メニューバー高さ = 画面全体の高さ - 可視領域の高さ - 可視領域のY位置
    // (Dockが下にある場合、visible_frame.origin.yがDock分だけ上にずれる)
    let menu_bar_height = frame.size.height - visible_frame.size.height - visible_frame.origin.y;
    menu_bar_height.max(0.0)
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

    for (title, x, y, width, height) in windows.iter() {
        // Skip if title is empty (can't reliably track)
        if title.is_empty() {
            continue;
        }

        // Check if window is minimized or fullscreen - skip if so (using title-based lookup)
        if ax_helper::is_window_minimized_by_title(pid, title).unwrap_or(false) {
            continue;
        }
        if ax_helper::is_window_fullscreen_by_title(pid, title).unwrap_or(false) {
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
        if let Some(original) = editor_positions.get(title) {
            let expected_y = original.y + offset_y;
            // 現在位置が期待位置（元の位置 + オフセット）に近ければ移動済み
            if (*y - expected_y).abs() < 5.0 {
                continue;
            }
        }

        // Save original position if not already saved
        if !editor_positions.contains_key(title) {
            editor_positions.insert(
                title.clone(),
                WindowFrame {
                    x: *x,
                    y: *y,
                    width: *width,
                    height: *height,
                },
            );
        }

        // Apply offset: move down by offset_y and reduce height by offset_y
        let new_y = y + offset_y;
        let new_height = height - offset_y;

        // Only apply if the new height is still reasonable
        const MIN_WINDOW_HEIGHT: f64 = 100.0;
        if new_height > MIN_WINDOW_HEIGHT {
            // Use title-based window frame setting to avoid index mismatch issues
            let _ = ax_helper::set_window_frame_by_title(pid, title, *x, new_y, *width, new_height);
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

    // Restore each window to its original position (using title-based lookup)
    for (title, _, _, _, _) in current_windows.iter() {
        if let Some(original) = editor_positions.get(title) {
            // Check if window is minimized or fullscreen - skip if so (using title-based lookup)
            if ax_helper::is_window_minimized_by_title(pid, title).unwrap_or(false) {
                continue;
            }
            if ax_helper::is_window_fullscreen_by_title(pid, title).unwrap_or(false) {
                continue;
            }

            // Use title-based window frame setting to avoid index mismatch issues
            if let Err(e) = ax_helper::set_window_frame_by_title(
                pid,
                title,
                original.x,
                original.y,
                original.width,
                original.height,
            ) {
                eprintln!("Failed to restore window frame for '{}': {}", title, e);
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
    std::path::Path::new(OFFSET_FILE_PATH).exists()
}
