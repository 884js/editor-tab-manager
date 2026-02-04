/// Editor configuration for multi-editor support
#[derive(Debug, Clone)]
pub struct EditorConfig {
    pub id: &'static str,           // "vscode", "cursor", "zed"
    pub display_name: &'static str, // "Visual Studio Code", "Cursor"
    pub bundle_id: &'static str,    // macOS bundle ID
    pub process_name: &'static str, // AppleScript process name
    pub app_name: &'static str,     // App name for activate command
}

/// List of supported editors (add new editors here)
pub const EDITORS: &[EditorConfig] = &[
    EditorConfig {
        id: "vscode",
        display_name: "Visual Studio Code",
        bundle_id: "com.microsoft.VSCode",
        process_name: "Code",
        app_name: "Visual Studio Code",
    },
    EditorConfig {
        id: "cursor",
        display_name: "Cursor",
        bundle_id: "com.todesktop.230313mzl4w4u92",
        process_name: "Cursor",
        app_name: "Cursor",
    },
    EditorConfig {
        id: "zed",
        display_name: "Zed",
        bundle_id: "dev.zed.Zed",
        process_name: "zed",
        app_name: "Zed",
    },
];

/// Get editor config by bundle ID
pub fn get_editor_by_bundle_id(bundle_id: &str) -> Option<&'static EditorConfig> {
    EDITORS.iter().find(|e| e.bundle_id == bundle_id)
}

/// Check if a bundle ID belongs to a supported editor
pub fn is_supported_editor(bundle_id: &str) -> bool {
    EDITORS.iter().any(|e| e.bundle_id == bundle_id)
}

/// Get all supported editor bundle IDs
#[allow(dead_code)]
pub fn get_supported_bundle_ids() -> Vec<&'static str> {
    EDITORS.iter().map(|e| e.bundle_id).collect()
}
