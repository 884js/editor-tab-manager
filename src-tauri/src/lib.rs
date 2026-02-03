mod editor;
mod notification;
mod observer;
mod vscode;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use vscode::{EditorState, EditorWindow, VSCodeState, VSCodeWindow};

// Legacy commands (backward compatible)
#[tauri::command(rename_all = "snake_case")]
fn get_vscode_windows() -> Vec<VSCodeWindow> {
    vscode::get_vscode_windows()
}

#[tauri::command(rename_all = "snake_case")]
fn get_vscode_state() -> VSCodeState {
    vscode::get_vscode_state()
}

#[tauri::command(rename_all = "snake_case")]
fn focus_vscode_window(window_id: i32) -> Result<(), String> {
    vscode::focus_vscode_window(window_id)
}

#[tauri::command(rename_all = "snake_case")]
fn open_new_vscode() -> Result<(), String> {
    vscode::open_new_vscode()
}

#[tauri::command(rename_all = "snake_case")]
fn close_vscode_window(window_id: i32) -> Result<(), String> {
    vscode::close_vscode_window(window_id)
}

#[tauri::command(rename_all = "snake_case")]
fn is_vscode_active() -> bool {
    vscode::is_vscode_active()
}

// New commands with bundle_id support
#[tauri::command(rename_all = "snake_case")]
fn get_editor_windows(bundle_id: &str) -> Vec<EditorWindow> {
    vscode::get_editor_windows(bundle_id)
}

#[tauri::command(rename_all = "snake_case")]
fn get_editor_state(bundle_id: &str) -> EditorState {
    vscode::get_editor_state(bundle_id)
}

#[tauri::command(rename_all = "snake_case")]
fn focus_editor_window(bundle_id: &str, window_id: i32) -> Result<(), String> {
    vscode::focus_editor_window(bundle_id, window_id)
}

#[tauri::command(rename_all = "snake_case")]
fn open_new_editor(bundle_id: &str) -> Result<(), String> {
    vscode::open_new_editor(bundle_id)
}

#[tauri::command(rename_all = "snake_case")]
fn close_editor_window(bundle_id: &str, window_id: i32) -> Result<(), String> {
    vscode::close_editor_window(bundle_id, window_id)
}

#[tauri::command(rename_all = "snake_case")]
fn clear_claude_notification(path: Option<String>) {
    notification::clear_notification_file_for_path(path.as_deref());
}

fn setup_shortcuts(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Cmd+Shift+T: New VSCode window
    let new_tab_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyT);

    // Cmd+W: Close current tab
    let close_tab_shortcut = Shortcut::new(Some(Modifiers::SUPER), Code::KeyW);

    // Cmd+1~9: Switch to tab
    let tab_shortcuts: Vec<Shortcut> = (1..=9)
        .map(|i| {
            let code = match i {
                1 => Code::Digit1,
                2 => Code::Digit2,
                3 => Code::Digit3,
                4 => Code::Digit4,
                5 => Code::Digit5,
                6 => Code::Digit6,
                7 => Code::Digit7,
                8 => Code::Digit8,
                9 => Code::Digit9,
                _ => Code::Digit1,
            };
            Shortcut::new(Some(Modifiers::SUPER), code)
        })
        .collect();

    let app_handle = app.clone();

    app.global_shortcut().on_shortcuts(
        [new_tab_shortcut, close_tab_shortcut]
            .into_iter()
            .chain(tab_shortcuts.clone())
            .collect::<Vec<_>>(),
        move |_app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }

            if shortcut == &new_tab_shortcut {
                let _ = vscode::open_new_vscode();
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("refresh-windows", ());
                }
            } else if shortcut == &close_tab_shortcut {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("close-current-tab", ());
                }
            } else {
                // Check if it's a tab switch shortcut
                for (i, tab_shortcut) in tab_shortcuts.iter().enumerate() {
                    if shortcut == tab_shortcut {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("switch-to-tab", i);
                        }
                        break;
                    }
                }
            }
        },
    )?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // Legacy commands (backward compatible)
            get_vscode_windows,
            get_vscode_state,
            focus_vscode_window,
            open_new_vscode,
            close_vscode_window,
            is_vscode_active,
            // New commands with bundle_id support
            get_editor_windows,
            get_editor_state,
            focus_editor_window,
            open_new_editor,
            close_editor_window,
            // Claude Code notification
            clear_claude_notification
        ])
        .setup(|app| {
            if let Err(e) = setup_shortcuts(app.handle()) {
                eprintln!("Failed to setup shortcuts: {}", e);
            }

            // Start NSWorkspace observer for app activation events
            observer::start_observer(app.handle().clone());

            // Start notification file watcher for Claude Code
            notification::start_notification_watcher(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
