# 不具合調査: 初回起動アプリでウィンドウサイズ判定が効かない

調査日: 2026-03-02

## 関連する過去の調査

- 前回: [troubleshoot-2026-03-02-4.md](./troubleshoot-2026-03-02-4.md)
- 前回の修正方針: AX API でウィンドウサイズを取得し、画面幅の 85% 以上なら「大きいウィンドウ」としてタブバーを非表示にする
- 前回の修正は正常に動作していたが、特定条件（コールドスタート）で追加の問題が発覚

## 症状

パターン: **A vs B 比較**（起動済みアプリ vs 初回起動アプリ）

- 既に起動済みのアプリに切り替えた場合、ウィンドウサイズ判定が正しく動作する（大きいウィンドウなら非表示、小さいウィンドウなら表示）
- Dock からアプリを初回起動した場合、ウィンドウサイズに関係なくタブバーが非表示になる

## 原因

実行フロー:
  1. Dock でアプリアイコンをクリック（起動開始） ← ✓
  2. NSWorkspaceDidActivateApplicationNotification 発火（起動直後） ← ✓
  3. `schedule_other_event` の 150ms debounce 後、AX API でウィンドウサイズを取得 ← ★ 問題箇所
  4. `get_largest_window_size` が None を返す（アプリがまだウィンドウを作成していない）
  5. `is_large_window_for_pid` が fallback で true を返す → タブバーが非表示

原因: アプリの初回起動時、NSWorkspaceDidActivateApplicationNotification は macOS がアプリプロセスを起動した直後に発火するが、アプリがウィンドウを作成するのはそれより遅い。150ms の debounce では不十分で、AX API がウィンドウを検出できない。`is_large_window_for_pid` は `get_largest_window_size` が None の場合に true（大きいウィンドウ扱い）をデフォルトにしていたため、結果的にすべての初回起動アプリでタブバーが非表示になっていた。

根拠: AX API の `get_all_window_frames` はウィンドウが存在しない場合に空の Vec を返し、`get_largest_window_size` は `max_by` が None を返す → `Option<(f64, f64)>` が None。

## 修正方針

### コード修正

1. `is_large_window_for_pid` を `check_window_size_for_pid` にリネームし、返り値を `Option<bool>` に変更（`observer.rs`）
   - `Some(true)`: 大きいウィンドウ（タブバー非表示）
   - `Some(false)`: 小さいウィンドウ（タブバー表示維持）
   - `None`: ウィンドウなし（コールドスタート）

2. `schedule_other_event` の `None` 分岐で:
   - まず `is_large_window: false` で emit（タブバーを表示状態に保つ）
   - `schedule_cold_start_recheck` で 4回 × 500ms のリトライを開始

3. `schedule_cold_start_recheck` を新規追加（`observer.rs`）
   - バックグラウンドスレッドで AX API を再チェック
   - ウィンドウが出現し、画面幅 85% 以上なら `is_large_window: true` で再 emit → タブバー非表示
   - DEBOUNCE_VERSION チェックで、別アプリに切り替わった場合は中断

### デバッグログの除去
- なし（デバッグログ追加せずにコード読解のみで原因特定）

## 次のアクション
- `pnpm tauri dev` で手動検証
