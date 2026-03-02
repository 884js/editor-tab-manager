// Tab bar height (px)
export const TAB_BAR_HEIGHT = 36;

export interface EditorWindow {
  id: number;
  name: string;
  path: string;
  branch?: string;
  bundle_id: string;
  editor_name: string;
}

export interface HistoryEntry {
  name: string;       // Project name
  path: string;       // File system path
  bundleId: string;   // Editor bundle ID
  editorName: string; // Editor display name
  timestamp: number;  // Date.now()
}

export const EDITOR_DISPLAY_NAMES: Record<string, string> = {
  "com.microsoft.VSCode": "VSCode",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "dev.zed.Zed": "Zed",
};

export const ALL_EDITOR_BUNDLE_IDS = Object.keys(EDITOR_DISPLAY_NAMES);

export const MAX_HISTORY_ENTRIES = 20;

export interface EditorState {
  is_active: boolean;
  windows: EditorWindow[];
  active_index: number | null;
}

// Payload from app-activated event
export interface AppActivationPayload {
  app_type: "editor" | "tab_manager" | "other";
  bundle_id: string | null;
  is_on_primary_screen: boolean;
  is_large_window: boolean;
}

// Claude Code status
export type ClaudeStatus = "waiting" | "generating";

// Payload from claude-status event
export interface ClaudeStatusPayload {
  statuses: Record<string, ClaudeStatus>;
}
