---
title: タブバーがアプリ切替時に表示されたままになるバグの修正 - 進捗管理
feature-name: tabbar-visibility-on-app-switch
plan: ./plan.md
created: 2026-03-12
updated: 2026-03-12
---

# 進捗管理: tabbar-visibility-on-app-switch

## 基本情報

| 項目 | 値 |
|------|-----|
| 機能名 | tabbar-visibility-on-app-switch |
| plan.md | [plan.md](./plan.md) |
| リポジトリ | 884js/vscode-tab-manager（モノレポ、Tauri 2 + React） |
| 関連ドキュメント | CLAUDE.md |

## タスク進捗

| # | タスク | 対象ファイル | 見積 | PR | リスク | 状態 |
|---|--------|-------------|------|-----|--------|------|
| T1 | `ax_observer_callback` の `K_AX_FOCUSED_WINDOW_CHANGED` ブランチに `get_frontmost_editor_pid()` ガードを追加。`cancel_pending_other_event()` と `window-focus-changed` emit をガード内に移動。`get_frontmost_editor_pid()` の `#[allow(dead_code)]` を除去 | `src-tauri/src/ax_observer.rs` | 15min | - | - | ✓ |

## デリバリープラン

分割なし（1 PR）

## 現在の状況

T1 完了。cargo check / clippy パス。手動テスト待ち。

## 次にやること

手動テストを実施し、問題なければ PR を作成する。
