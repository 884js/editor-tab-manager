use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct NativeEditorWindow {
    pub runtime_id: String,
    pub id: u32,
    pub title: String,
    pub is_frontmost: bool,
    pub renderer_pids: Vec<i32>,
}

impl NativeEditorWindow {
    pub fn new(
        bundle_id: &str,
        editor_pid: i32,
        id: u32,
        title: String,
        is_frontmost: bool,
        renderer_pids: Vec<i32>,
    ) -> Self {
        Self {
            runtime_id: format!("{}:{}:{}", bundle_id, editor_pid, id),
            id,
            title,
            is_frontmost,
            renderer_pids,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorSession {
    pub session_id: String,
    pub renderer_pid: i32,
    pub title: String,
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceResolution {
    Exact,
    Inferred,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorWindow {
    pub runtime_id: String,
    pub id: u32,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub repository_id: Option<String>,
    pub repository_name: Option<String>,
    pub bundle_id: String,
    pub editor_name: String,
    pub resolution: WorkspaceResolution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorState {
    pub is_active: bool,
    pub windows: Vec<EditorWindow>,
    pub active_index: Option<usize>,
}
