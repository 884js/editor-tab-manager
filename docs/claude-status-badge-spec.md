# Claude Status Badge 仕様

## 1. 概要

Claude Code の生成状態（生成中 / 入力待ち）をタブバーのバッジとして可視化する機能。
ユーザーはエディタを切り替えることなく、各プロジェクトで Claude Code が何をしているかを把握できる。

## 2. バッジの種類と表示ルール

| バッジ | 色 | 演出 | 表示条件 |
|--------|------|------|----------|
| generating | 赤 (`#ff3b30`) | パルスアニメーション (`pulse-animation`) | バックエンドから `generating` が通知されている間、常時表示 |
| waiting | 青 (`#007aff`) | なし | バックエンドから `waiting` が通知されている間、常時表示。ただしタブクリックで dismissed |
| なし | — | — | ステータスなし、または dismissed 状態 |

- バッジはタブ名の右・閉じるボタンの左に 8×8px の円形ドットとして描画される (`Tab.tsx`)。
- `generating` バッジはタブクリックでは消えない（作業が進行中のため）。

## 3. データフロー

```
/tmp/claude-code-events
        │
        │  (300ms polling / 差分読み取り)
        ▼
claude_status.rs ──emit("claude-status")──▶ App.tsx
                                              │
                                              │  claudeStatuses (filtered state)
                                              ▼
                                           TabBar.tsx
                                              │
                                              │  getClaudeStatusForTab()
                                              ▼
                                           Tab.tsx (バッジ描画)
```

### 補足

- `claude_status.rs` はバックグラウンドスレッドで起動し、ファイルの差分のみを読み取る。
- 状態が変化した行を処理するたびに即座に `emit` する（バッチ処理ではない）。
- ファイルが削除・切り詰められた場合は状態をクリアして空の `statuses` を emit する。

## 4. バックエンドのイベント形式

### イベントファイル

パス: `/tmp/claude-code-events`

行形式（追記型）:

```
<prefix> <project-path>
```

| prefix | 意味 |
|--------|------|
| `g` | generating（生成中） |
| `w` | waiting（入力待ち） |
| `c` | complete（完了 = ステータス削除） |

例:

```
g /Users/yukihayashi/Desktop/mywork/vscode-tab-manager
w /Users/yukihayashi/Desktop/mywork/vscode-tab-manager
c /Users/yukihayashi/Desktop/mywork/vscode-tab-manager
```

### Payload (`claude-status` イベント)

```typescript
interface ClaudeStatusPayload {
  statuses: Record<string, ClaudeStatus>;
  // key: プロジェクトのフルパス (例: "/Users/.../vscode-tab-manager")
  // value: "generating" | "waiting"
}
```

- `c` (complete) が来るとそのパスは `statuses` から削除される（キー自体が存在しない）。

### イベントの書き込み元（Claude Code Hooks）

`~/.claude/settings.json` に設定するフック構成:

| フック | prefix | 発火タイミング |
|--------|--------|---------------|
| `UserPromptSubmit` | `g` | ユーザーがプロンプトを送信した時 |
| `PostToolUse` | `g` | ツール実行完了後（パーミッション承認後を含む） |
| `Notification` (matcher: `permission_prompt`) | `w` | パーミッションダイアログが表示された時 |
| `Stop` | `w` | Claude が応答を停止した時 |

`PostToolUse` はパーミッション承認後に `w` → `g` へ復帰させる役割を持つ。
通常の生成中にも発火するが、`apply_line()` が同一ステータスの重複を無視するため余分な emit は発生しない。

## 5. フロントエンドの状態管理

### 二重構造

| 変数 | 型 | 役割 |
|------|------|------|
| `claudeStatusesRef` | `Ref<Record<string, ClaudeStatus>>` | バックエンドからの生データをそのまま保持 |
| `claudeStatuses` | `State<Record<string, ClaudeStatus>>` | dismissed をフィルタした後の表示用データ |

- `claudeStatusesRef` は常にバックエンドの最新状態を反映する（dismissed の影響を受けない）。
- `claudeStatuses` は dismissed な waiting を除外した状態を React state として保持し、UI の再レンダリングをトリガーする。

### タブとのマッチング (`TabBar.tsx`)

`getClaudeStatusForTab()` がフルパスの末尾ディレクトリ名とタブ名を比較してマッチングする。

```
"/Users/yukihayashi/Desktop/mywork/vscode-tab-manager"
                                    ↓ split('/').pop()
                              "vscode-tab-manager"  ←→  tab.name
```

## 6. dismissed のライフサイクル

### 状態遷移図

```
                    バックエンドから waiting 通知
                              │
                              ▼
                    ┌───────────────────┐
                    │  waiting バッジ表示 │
                    └───────┬───────────┘
                            │
                      タブクリック
                            │
                            ▼
                    ┌───────────────────┐
                    │    dismissed      │
                    │ (バッジ非表示)      │
                    └───────┬───────────┘
                            │
              バックエンドから waiting 以外
              (generating or 消滅) が通知
                            │
                            ▼
                    ┌───────────────────┐
                    │ dismissed 解除     │
                    └───────────────────┘
```

### dismissed の管理

- `dismissedWaitingRef`: `Ref<Set<string>>` — dismissed されたプロジェクトパスの Set。
- **追加条件**: `handleTabClick` でクリックされたタブに対応する waiting ステータスを検出し、そのパスを Set に追加。同時に `claudeStatuses` state からも即座に削除する。
- **解除条件**: `claude-status` イベント受信時、dismissed Set 内の各パスについてバックエンドのステータスが `"waiting"` 以外であれば Set から除外する。
- **復帰フロー例**: `waiting → [click: dismissed] → generating → waiting` = waiting バッジが再表示される。

## 7. リセット演出

`waiting → generating` の遷移を検出した場合、以下の演出を行う:

1. 該当パスのバッジを一時的に非表示にした `interim` ステートを `setClaudeStatuses` に反映
2. **150ms 後**に `generating` を含む `filtered` ステートを反映

これにより、ユーザーに「新しい生成が始まった」ことを視覚的に伝える。

### 検出ロジック (`App.tsx`)

```typescript
// waiting → generating の遷移を検出
const resetPaths = Object.keys(filtered).filter(
  path => filtered[path] === "generating" && prev[path] === "waiting"
);
```

- `prev` は `claudeStatusesRef.current`（前回のバックエンド生データ）。
- `filtered` は dismissed フィルタ適用後の今回のデータ。

## 8. 関連ファイル一覧

| ファイル | 役割 |
|----------|------|
| `src-tauri/src/claude_status.rs` | イベントファイルのポーリング・パース・emit |
| `src-tauri/src/claude_status_tests.rs` | `apply_line` のユニットテスト |
| `src/App.tsx` | `claude-status` イベントの購読、dismissed 管理、リセット演出 |
| `src/components/TabBar.tsx` | `claudeStatuses` をタブ名でマッチングし Tab に渡す |
| `src/components/Tab.tsx` | バッジの描画（色・アニメーション） |
| `docs/claude-code-status-detection.md` | バックエンド検知方式の初期設計メモ（本仕様とは別） |
