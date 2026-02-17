# 実装計画

## 参照ドキュメント

| ドキュメント | 説明 |
|---|---|
| [要件定義](./README.md) | 要件、データフロー、スコープ |
| [フロントエンド設計](./frontend-spec.md) | Tab コンポーネントへのブランチ名表示 + バックエンド変更 |
| api-spec.md | 該当なし（既存コマンドの拡張のみ） |
| db-spec.md | 該当なし（DB変更なし） |

## 実装タスク

| # | タスク | 依存 | 対象ファイル | 見積 |
|---|-------|------|------------|------|
| 1 | ax_helper.rs に get_document_path 関数追加 | - | `src-tauri/src/ax_helper.rs` | M |
| 2 | editor.rs に find_git_root + get_git_branch 関数追加 | - | `src-tauri/src/editor.rs` | S |
| 3 | EditorWindow に branch 追加 + ウィンドウ取得ロジック変更 | #1, #2 | `src-tauri/src/editor.rs` | M |
| 4 | EditorWindow 型に branch フィールド追加 | #3 | `src/App.tsx` | S |
| 5 | Tab コンポーネントへ branch prop 受け渡し | #4 | `src/components/TabBar.tsx` | S |
| 6 | ブランチ名表示UI実装 | #5 | `src/components/Tab.tsx` | M |
| 7 | Rust ユニットテスト | #2 | `src-tauri/src/editor.rs` | S |
| 8 | ビルド確認 + 手動テスト | #6, #7 | - | M |

### 依存関係図

```mermaid
graph TD
    T1["Task 1: ax_helper.rs<br/>get_document_path 関数追加"] --> T3
    T2["Task 2: editor.rs<br/>find_git_root + get_git_branch 関数追加"] --> T3
    T3["Task 3: editor.rs<br/>EditorWindow に branch 追加 + ウィンドウ取得ロジック変更"] --> T4
    T4["Task 4: App.tsx<br/>EditorWindow 型に branch 追加"] --> T5
    T5["Task 5: TabBar.tsx<br/>branch prop 受け渡し"] --> T6
    T6["Task 6: Tab.tsx<br/>ブランチ名表示UI"]
    T2 --> T7["Task 7: Rust ユニットテスト"]
    T6 --> T8["Task 8: ビルド確認 + 手動テスト"]
    T7 --> T8
```

### 見積基準

- **S**: 1ファイル、30行以下の変更
- **M**: 1-2ファイル、100行以下の変更
- **L**: 複数ファイル、または100行以上の変更

### Task 1: ax_helper.rs - get_document_path 関数追加

**ファイル**: `src-tauri/src/ax_helper.rs`

**内容**: AXUIElement から AXDocument 属性を取得し、ファイルパスを返す新規関数を追加する。

- `get_document_path(pid: i32, target_window_id: u32) -> Option<String>` を新規作成
- AXUIElement::application(pid) でアプリ要素を取得
- windows() で全ウィンドウを取得し、CGWindowID が一致するウィンドウを探す
- AXDocument 属性を取得（AXUIElementCopyAttributeValue）
- `file://` プレフィックスを除去してファイルパスを返す
- 取得失敗時は None を返す

**依存**: なし（Task 2 と並行可能）

**パターン参照**: 「既存の `is_window_minimized_by_id`（`src-tauri/src/ax_helper.rs`）の AXUIElementCopyAttributeValue パターンに倣う」

### Task 2: editor.rs - find_git_root + get_git_branch 関数追加

**ファイル**: `src-tauri/src/editor.rs`

**内容**: Git ブランチ名を取得するための2つの新規関数を追加する。

- `find_git_root(start_path: &Path) -> Option<PathBuf>`: パスから上位に向かって `.git` ディレクトリを探索し、git root を返す
- `get_git_branch(git_root: &Path) -> Option<String>`: `.git/HEAD` ファイルを読んでブランチ名を返す
  - `ref: refs/heads/main` 形式 → `"main"` を返す
  - コミットハッシュ（detached HEAD） → 先頭7文字を返す
  - 読み取り失敗 → None を返す

**依存**: なし（Task 1 と並行可能）

**備考**: git コマンドに依存せず、ファイル読み取りのみで高速に動作する

### Task 3: editor.rs - EditorWindow に branch 追加 + ウィンドウ取得ロジック変更

**ファイル**: `src-tauri/src/editor.rs`

**内容**: EditorWindow struct の拡張と、ウィンドウ取得時のブランチ名取得ロジックを追加する。

- EditorWindow struct に `pub branch: Option<String>` フィールドを追加
- `get_editor_state_with_config` 関数: ウィンドウ生成時に `get_document_path` → `find_git_root` → `get_git_branch` を呼び出し、`branch` フィールドに設定
- `get_editor_windows_with_config` 関数: 同上

```rust
let document_path = ax_helper::get_document_path(pid, *window_id);
let branch = document_path
    .and_then(|doc_path| {
        let dir = std::path::Path::new(&doc_path).parent()?;
        find_git_root(dir)
    })
    .and_then(|git_root| get_git_branch(&git_root));
```

**依存**: Task 1, Task 2

### Task 4: App.tsx - EditorWindow 型に branch 追加

**ファイル**: `src/App.tsx`

**内容**: EditorWindow interface に `branch?: string` を追加する。

```typescript
export interface EditorWindow {
  id: number;
  name: string;
  path: string;
  branch?: string;  // Git ブランチ名（Gitリポジトリでない場合は undefined）
}
```

その他の変更なし。バックエンドからの返却値に `branch` が含まれるため、`invoke<EditorWindow[]>` で取得した結果に自動的に反映される。

**依存**: Task 3（バックエンド変更後）

### Task 5: TabBar.tsx - branch prop 受け渡し

**ファイル**: `src/components/TabBar.tsx`

**内容**: Tab コンポーネントに `branch={tab.branch}` prop を追加する。

TabBarProps インターフェースの変更は不要。既に `tabs: EditorWindow[]` を受け取っており、`EditorWindow` 型に `branch` が追加されるため自動的に反映される。

**依存**: Task 4

### Task 6: Tab.tsx - ブランチ名表示UI

**ファイル**: `src/components/Tab.tsx`

**内容**: タブ内にGitブランチ名を2行目として表示するUI変更を行う。

- TabProps に `branch?: string` を追加
- `tabTextContent` ラッパー div を追加（flex-direction: column）
- `branchName` span を追加（`branch` がある場合のみ条件レンダリング）
- `tabName` スタイルから `flex: 1` を `tabTextContent` に移動
- 新規スタイル: `tabTextContent`（flex column, overflow hidden, flex 1, minWidth 0）, `branchName`（fontSize 10px, color rgba(255,255,255,0.5), ellipsis）

**依存**: Task 5

**パターン参照**: 「既存の `claudeStatus` バッジ（`src/components/Tab.tsx`）の条件レンダリングパターンに倣う」

### Task 7: Rust ユニットテスト

**ファイル**: `src-tauri/src/editor.rs`（`#[cfg(test)] mod tests`）

**内容**: find_git_root と get_git_branch のユニットテストを追加する。

| テスト | 検証内容 |
|--------|---------|
| find_git_root: 正常系 | gitリポジトリ内のパスで git root パスを返す |
| find_git_root: 非git | 非gitディレクトリで None を返す |
| get_git_branch: 通常ブランチ | `ref: refs/heads/main` → `"main"` |
| get_git_branch: detached HEAD | コミットハッシュ → 先頭7文字 |
| get_git_branch: 失敗 | `.git/HEAD` がない → None |

**依存**: Task 2

**コマンド**: `cargo test --manifest-path src-tauri/Cargo.toml`

### Task 8: ビルド確認 + 手動テスト

**内容**: 全タスク完了後のビルド確認と手動テストを実施する。

**依存**: Task 6, Task 7

**確認コマンド**:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri dev
```

## 影響範囲・リスク

### 影響を受ける既存機能

| 既存機能 | 影響内容 | リスク | 対策 |
|---------|---------|-------|------|
| EditorWindow struct (Rust) | Optional フィールド `branch` 追加 | 低 | Serialize で None → null。既存コマンドに影響なし |
| EditorWindow interface (TS) | Optional フィールド `branch?` 追加 | 低 | 既存の tab.name, tab.id 参照に影響なし |
| Tab.tsx レンダリング | tabName の flex:1 を tabTextContent に移動 | 中 | レイアウト確認必要（ドラッグ、カラー、バッジとの共存） |
| ax_helper.rs | 新規関数 get_document_path 追加のみ | 低 | 既存関数に変更なし |

### 後方互換性

- EditorWindow への `branch` フィールド追加は全て Optional（Rust: `Option<String>`, TS: `branch?: string`）のため、既存コードに影響なし
- 既存の Tauri コマンドのシグネチャ変更なし。返却値に新規フィールドが追加されるのみ
- フロントエンド側は `branch` が undefined の場合にブランチ行を非表示にするため、バックエンド未更新時も正常に動作

### パフォーマンスへの影響

- `.git/HEAD` ファイル読み取りは高速（git コマンド不使用）
- ウィンドウ数は通常5個以下のため、ファイルI/Oのオーバーヘッドは無視できるレベル
- `find_git_root` の上位ディレクトリ探索は最大でルートディレクトリまでだが、通常は2-3階層で見つかる

## テスト方針

### 自動テスト

| テストファイル | テスト内容 | 種別 |
|-------------|---------|------|
| `src-tauri/src/editor.rs` (#[cfg(test)]) | find_git_root: gitリポジトリ内のパスで git root パスを返す | unit |
| `src-tauri/src/editor.rs` (#[cfg(test)]) | find_git_root: 非gitディレクトリで None を返す | unit |
| `src-tauri/src/editor.rs` (#[cfg(test)]) | get_git_branch: `ref: refs/heads/main` → `"main"` | unit |
| `src-tauri/src/editor.rs` (#[cfg(test)]) | get_git_branch: detached HEAD → コミットハッシュ先頭7文字 | unit |
| `src-tauri/src/editor.rs` (#[cfg(test)]) | get_git_branch: `.git/HEAD` がない → None | unit |

### 手動検証チェックリスト

- [ ] Gitリポジトリのプロジェクトでブランチ名が表示される
- [ ] 非Gitリポジトリのプロジェクトでブランチ行が非表示
- [ ] ブランチ切り替え後、タブ切り替えで表示が更新される
- [ ] 長いブランチ名が省略表示（ellipsis）される
- [ ] Claude Status バッジとの共存（表示が崩れない）
- [ ] タブカラーとの共存（カラー表示が崩れない）
- [ ] ドラッグ&ドロップが正常に動作する
- [ ] 新規ウィンドウ（ファイル未開）でブランチ行が非表示

### ビルド確認

```bash
cargo check --manifest-path src-tauri/Cargo.toml   # 型チェック
cargo clippy --manifest-path src-tauri/Cargo.toml   # Lint
cargo test --manifest-path src-tauri/Cargo.toml     # テスト実行
pnpm tauri dev                                       # 動作確認
```
