# 不具合調査: 大きめウィンドウでタブバーが隠れる（ウィンドウサイズ閾値の限界）

調査日: 2026-03-02

## 関連する過去の調査

- 前回: [troubleshoot-2026-03-02-5.md](./troubleshoot-2026-03-02-5.md)
- 前回の修正方針: コールドスタート時のリトライ + デフォルト false
- 前回の修正は正常動作していたが、閾値ベースの判定自体に本質的な限界が判明

全6回の調査で循環する問題:

| # | 問題 | 修正 | 副作用 |
|---|------|------|--------|
| 1 | macOS設定で隠れる | 動的 level 切替 | — |
| 2 | ターミナルでも隠れる | 常時 level 9 | — |
| 3 | Slackで出っぱなし | setPosition隠し復活 | macOS設定で隠れる |
| 4 | macOS設定で隠れる | AX APIでウィンドウサイズ判定(85%閾値) | — |
| 5 | コールドスタートで判定不可 | リトライ + デフォルトfalse | — |
| 6 | 85%付近のウィンドウで隠れる | ← 今回 | — |

## 症状

パターン: **期待 vs 実際**

- **操作手順**: エディタ使用中に、画面幅の85%前後のウィンドウ（Claude等）を前面に表示
- **期待される動作**: エディタがまだ背後に見えているのでタブバーは表示されたまま
- **実際の動作**: 画面幅の85%を超えるとタブバーが非表示になる

## 原因

実行フロー:
  1. 非エディタアプリがアクティブに (observer.rs:289-291)        ← ✓
  2. schedule_other_event → 150ms debounce (observer.rs:136-141)  ← ✓
  3. check_window_size_for_pid(pid) (observer.rs:170)             ← ★ 問題箇所
     → screen_width * 0.85 と比較 (observer.rs:55)
  4. 前面ウィンドウ幅 >= 画面幅*85% → is_large_window: true      ← ✗
  5. setPosition(0, -10000) (useAppLifecycle.ts:361)              ← ✗

根本原因: `check_window_size_for_pid()` が「画面幅の85%」という固定閾値と比較している。
ユーザーの意図は「エディタが背後に見えている限りタブバーを表示したい」。
比較対象は画面幅ではなくエディタのウィンドウサイズであるべき。

閾値をどう調整しても別のウィンドウサイズで同じ問題が再発する（6回の調査で実証済み）。

## 修正方針

### コード修正

比較対象を「画面幅 × 閾値」から「エディタのウィンドウ幅」に変更する。

```
現在: front_window_width >= screen_width * 0.85
変更: front_window_width >= max_editor_window_width
```

1. `check_window_size_for_pid()` を `is_front_covering_editor()` にリネーム+ロジック変更 (observer.rs:49-56)
   - 前面アプリの最大ウィンドウ幅を取得（既存の `get_largest_window_size`）
   - `NSWorkspace::runningApplications()` から起動中エディタの PID を収集
   - エディタの最大ウィンドウ幅を AX API で取得
   - `front_width >= editor_width` → true（エディタが隠れている → タブバー非表示）
   - `front_width < editor_width` → false（エディタが見えている → タブバー表示）
   - エディタ未起動 → true（タブバーを出す意味がない）

2. `LARGE_WINDOW_THRESHOLD` 定数を削除 (observer.rs:58-60)

3. `schedule_cold_start_recheck` 内の比較も同様に変更 (observer.rs:88-92)

4. フロントエンド変更なし — `is_large_window` の意味が「エディタを覆っているか」に変わるだけ

### plan.md の修正

AC-2 の文言を更新:
- 旧: 「画面幅の85%以上を占めるウィンドウの場合はタブバーが非表示」
- 新: 「前面ウィンドウがエディタウィンドウ以上の幅の場合はタブバーが非表示」

### デバッグログの除去

なし（コード読解のみで原因特定）

## 次のアクション

直接修正
