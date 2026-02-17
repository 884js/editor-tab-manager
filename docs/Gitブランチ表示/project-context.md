# プロジェクトコンテキスト

## プロジェクト概要
- プロジェクト名: Editor Tab Manager (`editor-tab-manager`)
- 説明: macOS上でエディタ（VSCode, Cursor, Zed）の複数ウィンドウをブラウザのタブのように管理するTauri 2デスクトップアプリ

## 技術スタック
### フロントエンド (src/)
- フレームワーク: React 18 + Vite 5
- 言語: TypeScript 5.x
- UIライブラリ: なし（インラインスタイルで独自実装）
- 状態管理: React useState/useRef + @tauri-apps/plugin-store（永続化）
- i18n: i18next + react-i18next（ja/en対応）

### バックエンド (src-tauri/)
- フレームワーク: Tauri 2
- 言語: Rust (edition 2021)
- DB: なし（ファイルベースのStore: `tab-order.json`）

## 既存の型定義
- `EditorWindow` (Rust): id: u32, name: String, path: String
- `EditorWindow` (TS): id, name, path
- `EditorState`: is_active, windows, active_index
- `TabProps`: name, isActive, isDragging, onClick, onClose, etc.
- `TabBarProps`: tabs, activeIndex, onTabClick, onNewTab, onCloseTab, onReorder, claudeStatuses, tabColors, onColorChange

## アーキテクチャパターン
- ウィンドウ検出: macOS Accessibility API (`AXUIElement`) を直接使用
- ウィンドウ識別: CGWindowID（u32）による一意識別
- イベント駆動: NSWorkspace Observer + AXObserver → Tauri `emit` → フロントエンド
- 永続化: `@tauri-apps/plugin-store` (`tab-order.json`)

## 関連する既存機能
- `editor.rs`: ウィンドウ検出・タイトル解析。`EditorWindow.path` にウィンドウタイトル全体が格納
- `Tab.tsx` / `TabBar.tsx`: タブUI表示
- Claude Statusバッジ: バックエンド→イベント→フロントエンドで情報表示する類似パターン

## コーディング規約
- 常に日本語で会話する
- コミット前に必ず確認を取る
- 新しいUI文字列は `ja.json` と `en.json` の両方にキーを追加し、`t("key")` を使用

## 開発コマンド
- dev: `pnpm tauri dev`
- build: `pnpm tauri build`
- test: `cargo test --manifest-path src-tauri/Cargo.toml`
- lint: `cargo clippy --manifest-path src-tauri/Cargo.toml`
