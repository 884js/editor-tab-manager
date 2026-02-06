<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Editor Tab Manager" width="128" height="128">
</p>

<h1 align="center">Editor Tab Manager</h1>

<p align="center">
  A lightweight macOS desktop app that provides a persistent tab bar for managing multiple code editor windows.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-only-blue" alt="macOS">
  <img src="https://img.shields.io/badge/Tauri-2.0-orange" alt="Tauri">
  <a href="https://github.com/884js/vscode-tab-manager/releases"><img src="https://img.shields.io/github/v/release/884js/vscode-tab-manager" alt="GitHub Release"></a>
  <a href="https://github.com/884js/vscode-tab-manager/releases"><img src="https://img.shields.io/github/downloads/884js/vscode-tab-manager/total" alt="GitHub Downloads"></a>
  <a href="https://github.com/884js/vscode-tab-manager/stargazers"><img src="https://img.shields.io/github/stars/884js/vscode-tab-manager" alt="GitHub Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/884js/vscode-tab-manager" alt="License"></a>
</p>

---

<!-- TODO: Add screenshot -->
<!--
<p align="center">
  <img src="docs/screenshot.png" alt="Screenshot" width="800">
</p>
-->

## Table of Contents

- [Why This App?](#why-this-app)
- [Features](#features)
- [Supported Editors](#supported-editors)
- [Installation](#installation)
- [Usage](#usage)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Claude Code Integration](#claude-code-integration)
  - [Settings](#settings)
- [Development](#development)
- [Architecture](#architecture)
- [License](#license)

---

## Why This App?

複数のプロジェクトを同時に開発していると、エディタのウィンドウが増えていき、目的のウィンドウを探すのに時間がかかりませんか？

**Editor Tab Manager** は、ブラウザのタブバーのような UI で全てのエディタウィンドウを一覧表示します。`Cmd+1` 〜 `Cmd+9` のショートカットで瞬時に切り替え、作業効率を大幅に向上させます。

### Why not Multi-root Workspaces?

[マルチルートワークスペース](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)でも複数プロジェクトを扱えますが、独立したウィンドウなら「1ウィンドウ = 1プロジェクト」の明確な境界で集中しやすく、VSCode・Cursor・Zed それぞれで同じ操作感で使えます。

## Features

- **Tab Bar UI** - 全てのエディタウィンドウを常に表示されるタブバーで一覧
- **Quick Switching** - `Cmd+1` 〜 `Cmd+9` でタブを瞬時に切り替え
- **Multi-Editor Support** - VSCode, Cursor, Zed をサポート
- **Custom Tab Order** - ドラッグ＆ドロップでタブを並び替え、順序は再起動後も保持
- **Claude Code Integration** - Claude Code のタスク待機状態をバッジで通知

## Supported Editors

| Editor | Status |
|--------|--------|
| Visual Studio Code | ✅ Supported |
| Cursor | ✅ Supported |
| Zed | ✅ Supported |

## Installation

### Download

[Releases ページ](https://github.com/884js/vscode-tab-manager/releases) から最新の `.dmg` ファイルをダウンロードしてインストールできます。

### Build from Source

#### Prerequisites

- macOS
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)

#### Steps

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

アプリはメニューバーに常駐します。トレイアイコンをクリックして設定やアプリの終了ができます。

### Claude Code Integration

[Claude Code](https://claude.ai/code) と連携して、タスクの待機状態をタブバーにバッジ表示します。

#### Setup

この機能を使うには、Claude Code 側で hooks を設定する必要があります。

`~/.claude/settings.json` に以下を追加してください：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "echo \"g $CLAUDE_PROJECT_DIR\" >> /tmp/claude-code-events"
        }]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{
          "type": "command",
          "command": "echo \"w $CLAUDE_PROJECT_DIR\" >> /tmp/claude-code-events"
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "echo \"w $CLAUDE_PROJECT_DIR\" >> /tmp/claude-code-events"
        }]
      }
    ]
  }
}
```

この設定により、Claude Code のイベント（プロンプト送信・権限確認・停止）が `/tmp/claude-code-events` に書き込まれます。

#### How it works

1. ユーザーがプロンプトを送信すると、hooks により `g <path>`（生成中）をイベントファイルに書き込み
2. Claude Code が権限確認や停止すると、hooks により `w <path>`（待機中）をイベントファイルに書き込み
3. Editor Tab Manager がファイルを監視し、バッジを表示
   - 🔵 青バッジ: 入力待ち（waiting）
   - 🔴 赤バッジ（パルス）: 生成中（generating）

この連携により、別のプロジェクトで作業中でも Claude Code の状態を一目で把握できます。

**対応エディタ**: VSCode, Cursor（Claude Code の実行環境として）

### Settings

設定画面（トレイアイコンから開く）で以下の項目を設定できます：

- **有効なエディタの選択** - タブバーに表示するエディタを選択
- **タブの並び順** - タブの表示順序をカスタマイズ

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

### Project Structure

```
├── src/                    # Frontend (React + TypeScript)
│   ├── App.tsx            # Main component
│   └── components/        # UI components
├── src-tauri/             # Backend (Rust + Tauri)
│   └── src/
│       ├── lib.rs         # Tauri setup, commands
│       ├── editor.rs      # Window detection/manipulation
│       ├── observer.rs    # App activation observer
│       └── claude_status.rs # Claude Code integration
```

## License

[MIT](LICENSE)
