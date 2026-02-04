# Editor Tab Manager

A lightweight macOS desktop app that provides a persistent tab bar for managing multiple code editor windows.

![macOS](https://img.shields.io/badge/macOS-only-blue)
![Tauri](https://img.shields.io/badge/Tauri-2.0-orange)

## Features

- **Tab Bar UI** - View all open editor windows in a persistent, always-on-top tab bar
- **Quick Switching** - Switch between projects with `Cmd+1` through `Cmd+9`
- **Multi-Editor Support** - Works with VSCode, Cursor, and Zed
- **Custom Tab Order** - Drag to reorder tabs; order persists across restarts
- **Claude Code Integration** - Shows badge notifications for waiting Claude Code tasks

## Supported Editors

| Editor | Status |
|--------|--------|
| Visual Studio Code | ✅ Supported |
| Cursor | ✅ Supported |
| Zed | ✅ Supported |

## Installation

### Prerequisites

- macOS
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)

### Build from Source

```bash
# Clone the repository
git clone https://github.com/884js/vscode-tab-manager.git
cd vscode-tab-manager

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build for production
pnpm tauri build
```

## Usage

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+1` - `Cmd+9` | Switch to tab N |
| `Cmd+Shift+T` | Open new editor window |
| `Cmd+W` | Close current tab |

### Menu Bar

The app runs in the menu bar. Click the tray icon to access settings or quit.

## Development

```bash
# Start development server
pnpm tauri dev

# Check Rust code
cargo check --manifest-path src-tauri/Cargo.toml

# Lint Rust code
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## Architecture

- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust + Tauri 2
- **macOS Integration**: NSWorkspace APIs, AppleScript for window control

## License

MIT
