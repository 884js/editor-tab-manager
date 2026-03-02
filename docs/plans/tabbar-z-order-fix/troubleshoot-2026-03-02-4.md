# 不具合調査: macOS 設定ウィンドウでタブバーが隠れる（4回目の循環）

調査日: 2026-03-02

## 関連する過去の調査

- 前回: [troubleshoot-2026-03-02-3.md](./troubleshoot-2026-03-02-3.md)
- 前回の修正方針: `setPosition(0, -10000)` を復活させて Slack でタブバーが出ないようにする
- 前回の修正が引き起こした問題: macOS 設定ウィンドウでもタブバーが隠れてしまう

## 症状

パターン: A vs B 比較（循環的矛盾）

- **操作手順**: macOS システム設定を開く
- **期待される動作**: タブバーが表示されたまま
- **実際の動作**: タブバーが隠れる

4回の調査で循環する矛盾が明確になった:

| # | 問題 | 修正 | 副作用 |
|---|------|------|--------|
| 1 | macOS設定で隠れる | 動的 level 切替 | — |
| 2 | Terminalでも隠れる | 常時 level 9 | — |
| 3 | Slackで出っぱなし | setPosition 隠し復活 | macOS設定で隠れる |
| 4 | macOS設定で隠れる | ← 今ここ（1に戻る）| — |

## 原因

`app_type === "other"` が全ての非エディターアプリを一律に扱っていることが根本原因。
Slack（画面幅いっぱいのウィンドウ）と macOS 設定（小さいウィンドウ）を区別する仕組みがない。

実行フロー:
  1. macOS 設定が起動                                            ← ✓
  2. observer.rs: bundle_id 判定 → "other"                      ← ✓
  3. 150ms debounce 後に emit                                    ← ✓
  4. useAppLifecycle.ts:354-361: app_type === "other" → 一律隠す  ← ★ 問題箇所
  5. setPosition(0, -10000) でタブバーが画面外に移動              ← ✗

根拠: macOS 設定は画面幅の約 47%（680px / 1440px）しか占めないが、
Slack と同じ "other" として処理されるため一律非表示になる。

## 修正方針

### コード修正

"other" アプリのフロントウィンドウのサイズをチェックし、画面幅に対する占有率で
タブバーの表示/非表示を判定する。

判定基準: ウィンドウ幅 >= 画面幅の 85% → タブバー非表示
          ウィンドウ幅 < 画面幅の 85% → タブバー表示維持

1. `ax_helper.rs` — フォーカスウィンドウのフレーム取得関数を新設
2. `observer.rs` — `AppActivationPayload` に `is_large_window: bool` を追加、
   "other" 判定時にフロントウィンドウのサイズチェックを実施
3. `src/types/editor.ts` — TypeScript 型に `is_large_window` を追加
4. `src/hooks/useAppLifecycle.ts` — `is_large_window === true` の場合のみ隠す

既存インフラ:
- `ax_helper::get_all_window_frames(pid)` — AXUIElement でウィンドウフレーム取得
- `window_offset::get_primary_screen_size()` — NSScreen でスクリーンサイズ取得

### plan.md の修正

不要。

### デバッグログの除去

なし

## 次のアクション

直接修正
