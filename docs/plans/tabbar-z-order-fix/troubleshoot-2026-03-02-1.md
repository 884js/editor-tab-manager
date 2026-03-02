# 不具合調査: macOS システム設定を開くとタブバーが隠れる

調査日: 2026-03-02

## 関連する過去の調査

なし（初回調査）

## 症状

パターン: 期待 vs 実際

- **操作手順**: エディター使用中に macOS システム設定を開く
- **期待される動作**: タブバーが表示されたまま（z-order 修正により他のウィンドウより上に表示）
- **実際の動作**: タブバーが消える

## 原因

z-order 修正 (NSWindowLevel=9) は正常に設定されているが、`app-activated` イベントの `app_type: "other"` ハンドラがタブバーを物理的に画面外へ移動 (`y: -10000`) するため、z-order の効果が無効化されている。

実行フロー:
  1. macOS System Settings がアクティベート (`observer.rs:191`)  ← ✓
  2. `schedule_other_event()` で 150ms デバウンス (`observer.rs:64-108`)  ← ✓
  3. `app-activated` が `app_type: "other"` で emit (`observer.rs:98-105`)  ← ✓
  4. `useAppLifecycle.ts:408-421` の else ブロック  ← ★ 問題箇所
  5. `appWindow.setPosition(PhysicalPosition(0, -10000))` (`useAppLifecycle.ts:418`)  ← ✗

根拠: `useAppLifecycle.ts:416-419` で `is_on_primary_screen && isVisibleRef.current` の条件を満たすと無条件に画面外移動が実行される。macOS System Settings はエディターの「上に」表示される小さなウィンドウだが、observer にとっては「非エディターアプリ」なので `app_type: "other"` として分類され、タブバーが隠される。

## 修正方針

### コード修正

`useAppLifecycle.ts:408-422` の `app_type === "other"` ハンドラを修正する。

**方針**: `app_type: "other"` 受信時にタブバーを画面外に移動する代わりに、z-order (NSWindowLevel=9) に依存してタブバーの表示を維持する。タブバーは常に画面上の位置 (0, 0) に留まり、NSWindowLevel=9 により他のウィンドウより上に表示される。

ただし、plan.md の受入条件 AC2「他のアプリ（ブラウザ等）に切り替えるとタブバーが隠れる」と矛盾する可能性がある。以下の選択肢をユーザーに提示:

1. **タブバーを常に表示**: `app_type: "other"` でも画面外移動しない。z-order で常に最前面。AC2 を変更
2. **エディターが見えているときだけ表示**: フロントアプリのウィンドウサイズを判定し、全画面なら隠す / 小さいウィンドウなら表示を維持（実装が複雑）
3. **現状維持**: AC2 通り、非エディターアプリに切り替えたら隠す（ユーザーの報告した問題は仕様通り）

### plan.md の修正

選択肢 1 を採用する場合:
- AC2 の文言を修正:「他のアプリに切り替えてもタブバーは表示されたまま」に変更
- 実装タスクの修正が必要

### デバッグログの除去

なし（調査用ログは追加していない）

## 次のアクション

ユーザーに修正方針の選択肢を確認し、決定後に `/implement` で修正
