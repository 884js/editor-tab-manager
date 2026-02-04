mod ax_helper;
mod editor;
mod editor_config;
mod notification;
mod observer;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use editor::{EditorState, EditorWindow};

// Editor commands with optional bundle_id support
#[tauri::command(rename_all = "snake_case")]
fn get_editor_windows(bundle_id: Option<&str>) -> Vec<EditorWindow> {
    match bundle_id {
        Some(id) => editor::get_editor_windows(id),
        None => editor::get_any_editor_windows(),
    }
}

#[tauri::command(rename_all = "snake_case")]
fn get_editor_state(bundle_id: Option<&str>) -> EditorState {
    match bundle_id {
        Some(id) => editor::get_editor_state(id),
        None => editor::get_any_editor_state(),
    }
}

#[tauri::command(rename_all = "snake_case")]
fn focus_editor_window(bundle_id: &str, window_id: i32) -> Result<(), String> {
    editor::focus_editor_window(bundle_id, window_id)
}

#[tauri::command(rename_all = "snake_case")]
fn open_new_editor(bundle_id: &str) -> Result<(), String> {
    editor::open_new_editor(bundle_id)
}

#[tauri::command(rename_all = "snake_case")]
fn close_editor_window(bundle_id: &str, window_id: i32) -> Result<(), String> {
    editor::close_editor_window(bundle_id, window_id)
}

#[tauri::command(rename_all = "snake_case")]
fn is_editor_active() -> bool {
    editor::is_editor_active()
}

#[tauri::command(rename_all = "snake_case")]
fn clear_claude_notification(path: Option<String>) {
    notification::clear_notification_file_for_path(path.as_deref());
}

#[tauri::command(rename_all = "snake_case")]
fn open_file_in_default_app(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn setup_shortcuts(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Cmd+Shift+T: New editor window
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
                // Emit event to frontend, which knows the current bundle_id
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("open-new-editor-tab", ());
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
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            // Editor commands with bundle_id support
            get_editor_windows,
            get_editor_state,
            focus_editor_window,
            open_new_editor,
            close_editor_window,
            is_editor_active,
            // Claude Code notification
            clear_claude_notification,
            // File operations
            open_file_in_default_app,
            // Accessibility permissions
            check_accessibility_permission,
            request_accessibility_permission,
            open_accessibility_settings
        ])
        .setup(|app| {
            // Set app as accessory (no Dock icon, menu bar only)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Setup menu bar tray icon
            let settings_item = MenuItem::with_id(app, "settings", "設定...", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Editor Tab Manager", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(false)
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "settings" {
                        if let Some(window) = app.get_webview_window("main") {
                            // ウィンドウを先に表示してからイベントを送信
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("show-settings", ());
                        }
                    } else if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;

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
