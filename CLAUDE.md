# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Development (starts Tauri + Vite)
pnpm tauri dev

# Build
pnpm build              # Frontend only
pnpm tauri build        # Full app build

# Rust checks
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## Architecture Overview

Editor Tab Manager is a Tauri 2 desktop app providing a tab bar UI for managing multiple editor windows (VSCode, Cursor, Zed) on macOS.

### Frontend (src/)
- **React + TypeScript** with Vite
- `App.tsx` - Main component with window state, tab ordering, event handling
- `components/TabBar.tsx`, `Tab.tsx` - Tab bar UI
- `components/Settings.tsx` - Settings panel

### Backend (src-tauri/src/)
- **lib.rs** - Tauri setup, commands, global shortcuts (Cmd+1-9 for tab switching)
- **editor.rs** - Window detection/manipulation via AppleScript
- **editor_config.rs** - Editor definitions (id, bundle_id, display_name)
- **observer.rs** - NSWorkspace observer for app activation events
- **claude_status.rs** - Claude Code status detection via event log files

### Key Data Flows
1. **App Activation**: observer.rs detects editor activation → emits `app-activated` → frontend refreshes window list
2. **Window Operations**: Frontend calls Tauri commands → editor.rs executes AppleScript
3. **Claude Code Badge**: claude_status.rs watches event log files → emits `claude-status-changed` → frontend shows badge

### Editor Support
New editors are added in `editor_config.rs`. Each editor needs:
- `id`: Internal identifier
- `bundle_id`: macOS bundle ID
- `display_name`: UI display name
- `process_name`: AppleScript process name
- `app_name`: AppleScript application name

Window title parsing in `editor.rs` may need adjustment per editor (see `extract_project_name`).

## Conventions

- 常に日本語で会話する
- コミット前に必ず確認を取る
