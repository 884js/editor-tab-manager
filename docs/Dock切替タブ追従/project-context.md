# Project Context

## 技術スタック
- **フロントエンド**: React 18 + TypeScript, Vite 5, Tauri 2 API
- **バックエンド**: Rust (Tauri 2), objc2 クレート (NSWorkspace / Accessibility API)
- **プラットフォーム**: macOS 専用 (AppleScript + Accessibility API + NSWorkspace observer)
- **永続化**: @tauri-apps/plugin-store (JSON ファイル)

## 関連ファイル
### バックエンド
- `src-tauri/src/observer.rs` - NSWorkspace アプリアクティベーション検出
- `src-tauri/src/ax_observer.rs` - Accessibility API ウィンドウイベント監視
- `src-tauri/src/editor.rs` - エディタウィンドウ情報取得
- `src-tauri/src/ax_helper.rs` - Accessibility API ラッパー
- `src-tauri/src/lib.rs` - Tauri コマンド定義

### フロントエンド
- `src/hooks/useAppLifecycle.ts` - アプリライフサイクル管理 (show/hide, resize)
- `src/hooks/useEditorWindows.ts` - エディタウィンドウ状態管理
- `src/types/editor.ts` - 型定義 (AppActivationPayload 等)

## イベントフロー
1. observer.rs: NSWorkspaceDidActivateApplicationNotification 監視
2. アプリ分類: editor / tab_manager / other
3. editor/tab_manager → 即座に `app-activated` イベント emit
4. other → 150ms デバウンス後に emit
5. フロントエンド: `app-activated` で show/hide + ウィンドウリスト更新

## ウィンドウ設定
- `alwaysOnTop: true`, `transparent: true`, `decorations: false`
- `ActivationPolicy::Accessory` (Dock アイコンなし)
- `hardenedRuntime: true`
