---
plan: "./plan.md"
feature: "tabbar-z-order-fix"
started: 2026-03-02
updated: 2026-03-02
mode: single
---

# タブバー z-order 修正 + 設定画面の別ウィンドウ分離 — 実装進捗

## 現在の状況

全タスク (#1〜#5) 完了。ビルド・テスト (79件) 全パス。手動検証完了。PR #52 作成済み。

## 次にやること

完了。PR レビュー待ち。

## タスク進捗

| # | タスク | 対象ファイル | 見積 | 状態 |
|---|-------|------------|------|------|
| 1 | Cargo.toml に NSWindow feature 追加、tauri.conf.json の alwaysOnTop 削除 | `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` | S | ✓ |
| 2 | lib.rs の setup 内にカスタムウィンドウレベル設定ロジックを追加 | `src-tauri/src/lib.rs` | M | ✓ |
| 3 | lib.rs に設定ウィンドウ作成・管理コマンドを追加、トレイメニューのハンドラを変更、capabilities に設定ウィンドウの権限を追加 | `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json` | M | ✓ |
| 4 | フロントエンドにウィンドウラベルベースのルーティングを追加、useAppLifecycle の設定表示ロジックを変更、Settings の閉じるボタン動作を変更 | `src/App.tsx`, `src/hooks/useAppLifecycle.ts`, `src/components/Settings.tsx` | M | ✓ |
| 5 | 結合テスト、全受入条件の手動検証 | 全体 | M | ✓ |

> タスク定義の詳細は [plan.md](./plan.md) を参照

## ブランチ・PR

| ブランチ | PR URL | 状態 |
|---------|--------|------|
| feature/tabbar-z-order-fix | https://github.com/884js/editor-tab-manager/pull/52 | Open |

## 作業ログ

| 日時 | 内容 |
|------|------|
| 2026-03-02 | 1 PR で実装開始 |
| 2026-03-02 | troubleshoot 実施 → troubleshoot-2026-03-02-1.md 参照 |
| 2026-03-02 | troubleshoot 実施 → troubleshoot-2026-03-02-2.md 参照 |
| 2026-03-02 | troubleshoot 実施 → troubleshoot-2026-03-02-3.md 参照 |
| 2026-03-02 | troubleshoot 実施 → troubleshoot-2026-03-02-4.md 参照 |
| 2026-03-02 | troubleshoot 実施 → troubleshoot-2026-03-02-5.md 参照 |
