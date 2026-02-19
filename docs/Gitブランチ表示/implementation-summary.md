# Gitブランチ表示 — 実装サマリ（Implementation Summary）

> 生成日: 2026-02-18

## 機能概要

各タブ内にプロジェクトの現在のGitブランチ名を表示する機能を実装。バックエンド（Rust）でプロジェクトパスの多段解決→.git/HEAD読み取りによるブランチ名取得を行い、フロントエンド（React）でタブ内にブランチ名を2行目として表示する。設定画面からブランチ表示のON/OFFが切り替え可能。

## データフロー

### ブランチ名の取得と表示

1. macOS NSWorkspace / AXObserver がアプリアクティベーション/ウィンドウ変更を検出
2. バックエンド `editor.rs::get_editor_state()` が呼び出される
   - `ax_helper::get_windows_ax(pid)` でウィンドウリスト取得（CGWindowID, title, is_frontmost）
   - `extract_project_name(title)` でプロジェクト名抽出
   - `resolve_project_path(name, editor_id, pid, window_id)` で多段フォールバック:
     1. キャッシュ（PROJECT_PATH_CACHE）から検索
     2. workspaceStorage から一括読み込み → キャッシュに格納
     3. キャッシュ済みパスのサブディレクトリ検索
     4. AXDocument フォールバック（ax_helper::get_document_path）→ find_git_root
   - `find_git_root(path)` で .git ディレクトリ/ファイルを探索
   - `get_git_branch(git_root)` で .git/HEAD を読み取りブランチ名取得
     - `resolve_git_dir()` でサブモジュール対応（.git ファイル → gitdir 参照解決）
     - `ref: refs/heads/...` → ブランチ名
     - コミットハッシュ → 先頭7文字
3. `EditorWindow { id, name, path, branch }` をフロントエンドに返却
4. フロントエンド `App.tsx::fetchWindows()` で branch の変更も差分検知
5. `TabBar.tsx` が `showBranch !== false ? tab.branch : undefined` で Tab に渡す
6. `Tab.tsx` が `branch` がある場合のみ `⎇ {branch}` を表示

### ブランチ表示の設定切り替え

1. Settings.tsx でトグル操作 → `onShowBranchToggle(enabled)`
2. App.tsx で `setShowBranch(enabled)` + `store.set("settings:showBranch", enabled)`
3. TabBar.tsx に `showBranch` prop を渡す
4. Tab への branch 渡しを `showBranch` で制御

## 技術サマリー

- **API**: 既存コマンド `get_editor_windows` / `get_editor_state` の返却値に `branch` フィールドを追加（新規エンドポイントなし）
- **DB**: 該当なし（DB変更なし）
- **UI**:
  - `Tab.tsx`: `tabTextContent` ラッパー div 追加、`branchName` span 追加（条件レンダリング）
  - `TabBar.tsx`: `showBranch` prop 追加、Tab への branch 渡し制御
  - `Settings.tsx`: showBranch トグル設定UI追加
  - `App.tsx`: EditorWindow 型に `branch?` 追加、`showBranch` 設定状態管理、branch 変更検知
  - i18n: `settings.showBranchLabel` / `settings.showBranchDescription` キー追加（ja/en）

### バックエンド新規関数

| 関数 | ファイル | 役割 |
|------|---------|------|
| `resolve_project_path` | editor.rs | プロジェクト名→フルパスの多段解決 |
| `load_workspace_paths` | editor.rs | workspaceStorage からパスマッピング読み込み |
| `get_workspace_storage_dir` | editor.rs | エディタIDごとの workspaceStorage パス |
| `percent_decode` | editor.rs | URLパーセントエンコーディングのデコード |
| `find_git_root` | editor.rs | パスから上位に .git を探索 |
| `resolve_git_dir` | editor.rs | .git の実体ディレクトリ解決（サブモジュール対応） |
| `get_git_branch` | editor.rs | .git/HEAD 読み取りでブランチ名取得 |
| `get_document_path` | ax_helper.rs | AXDocument 属性からファイルパス取得 |

### グローバルキャッシュ

| 変数 | 型 | 役割 |
|------|---|------|
| `PROJECT_PATH_CACHE` | `Mutex<HashMap<String, PathBuf>>` | プロジェクト名→フルパスのキャッシュ |
| `CACHE_INITIALIZED` | `Mutex<HashMap<String, bool>>` | エディタIDごとの初期化フラグ |

### 依存ライブラリ追加（Cargo.toml）

- `dirs = "5"` — ホームディレクトリ取得（workspaceStorage パス解決用）
- `lazy_static = "1.4"` — グローバルキャッシュ用
