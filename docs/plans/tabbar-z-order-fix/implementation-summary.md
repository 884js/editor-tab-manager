# タブバー z-order 修正 + 設定画面の別ウィンドウ分離 — 実装サマリ（Implementation Summary）

> 生成日: 2026-03-02
> 検証モード: フル検証

## 機能概要

エディタのサブウィンドウ（設定画面、モーダルパネル等）がタブバーを隠す問題を、NSWindowLevel のカスタム設定（level 9）で解決。あわせて設定画面を別 Tauri WebviewWindow に分離し、設定表示中もタブバーが維持されるようにした。さらに troubleshoot で発見された問題に対応し、ウィンドウサイズベースの表示判定とコールドスタートリトライ機能を追加した。

## 処理フロー

### 1. カスタムウィンドウレベル設定（起動時）
- `lib.rs` の setup 内で `with_webview()` → NSWindow に直接アクセス → `setLevel(9)` を設定
- NSModalPanelWindowLevel (8) より上、Dock (20) / メニューバー (24) より下
- `tauri.conf.json` の `alwaysOnTop` は `false` に変更（Rust コードで直接制御）

### 2. 設定ウィンドウ管理
- `open_settings_window()`: ウィンドウラベル `"settings"` で既存チェック
  - 存在する場合: `show()` + `set_focus()` で前面化
  - 未作成の場合: `WebviewWindowBuilder` で新規作成（600x600, center, resizable: false）
- トレイメニューの「設定」クリック時と `show_settings_window` Tauri コマンド経由で呼び出し

### 3. フロントエンドルーティング
- `App.tsx`: `getCurrentWindow().label` でウィンドウラベルを判定
  - `"settings"` → `<Settings />` のみレンダリング（早期リターン）
  - それ以外 → 従来のタブバー初期化フロー
- `Settings.tsx`: 自己完結型に変更（Store 読み書き、autostart 制御を内包）。閉じるボタンは `getCurrentWindow().close()`

### 4. ウィンドウサイズベースの表示制御（仕様外追加）
- `observer.rs`: 他アプリがアクティブ時に AX API でウィンドウサイズを取得
- スクリーン幅の 85% 以上 → `is_large_window: true`（タブバー非表示）
- スクリーン幅の 85% 未満 → `is_large_window: false`（タブバー表示維持）
- コールドスタート（ウィンドウ未生成）→ 最大 4 回 × 500ms でリトライ

## 技術サマリー

- **バックエンド**: `open_settings_window` / `show_settings_window` コマンド追加、NSWindowLevel 設定、`check_window_size_for_pid` / `schedule_cold_start_recheck` 追加
- **UI**: Settings を別ウィンドウに分離、ウィンドウラベルベースのルーティング追加
- **仕様外追加**: `AppActivationPayload` に `is_large_window` フィールド追加、`get_largest_window_size` ヘルパー追加
