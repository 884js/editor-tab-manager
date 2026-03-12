# リサーチ: タブバーがアプリ切替時に表示されたままになるバグの原因調査

調査日: 2026-03-12
調査タイプ: コードベース

## 調査ゴール
エディタ以外のアプリに切り替えたときに、タブバーが「たまに」表示されたままになる原因を特定する。

## 現状

### 表示/非表示の制御メカニズム

タブバーは `show()`/`hide()` ではなく **ウィンドウ位置の移動** で制御されている:

| 状態 | 位置 | 箇所 |
|------|------|------|
| 表示 | `PhysicalPosition(0, 0)` | `useAppLifecycle.ts:L324`, `useEditorWindows.ts:L397` |
| 非表示 | `PhysicalPosition(0, -10000)` | `useAppLifecycle.ts:L360` |

ウィンドウレベルは 9（NSModalPanelWindowLevel + 1）で、通常のウィンドウより上に表示される。

### イベントフロー

```
macOS NSWorkspaceDidActivateApplicationNotification
  └→ observer.rs
       ├→ エディタ: 即座に app-activated(app_type="editor") を emit
       ├→ タブマネージャ: 即座に app-activated(app_type="tab_manager") を emit
       └→ その他: 150msデバウンス後に emit
            └→ frontmostApplicationを再確認
                 ├→ エディタだった場合: "editor" で emit
                 └→ その他: is_front_covering_editor() でウィンドウサイズ比較
                      ├→ 覆い隠す → covers_editor=true → 非表示
                      ├→ 覆い隠さない → covers_editor=false → 表示維持
                      └→ ウィンドウなし → covers_editor=false + cold start recheck
```

### フロントエンド側の非表示条件 (`useAppLifecycle.ts:L354-362`)

```
if (is_on_primary_screen) {
  // ウィンドウオフセット復元
  if (covers_editor && isVisibleRef.current) {
    // タブバー非表示
  }
}
```

**3つの条件すべてが `true` でないと非表示にならない。**

## 調査結果

### 根本原因: `window-focus-changed` による意図しない再表示

**フルスクリーンブラウザを含むあらゆるアプリへの切替で発生しうることから、`covers_editor` の判定問題ではなく、非表示後に再表示されてしまう問題が主因。**

#### 再現フロー

1. ブラウザに切替 → `app-activated(other, covers_editor=true)` → タブバー非表示 ✅
2. バックグラウンドのエディタが `AXFocusedWindowChanged` を発火（macOSが内部的にウィンドウフォーカスを変更）
3. `ax_observer.rs:L139` → `window-focus-changed` イベントが emit
4. `useEditorWindows.ts:L387-398`:
   - `isEditorActiveRef` が `true` に戻される（誤判定）
   - `isVisibleRef` が `false` なので、タブバーが `(0, 0)` に再表示される

```typescript
// useEditorWindows.ts L381-406 — 問題のコード
const unlistenWindowFocus = await listen("window-focus-changed", async () => {
  if (!isMounted) return;

  // Approach 6: エディタがアクティブと仮定して復帰 ← ここが問題
  if (!isEditorActiveRef.current) {
    isEditorActiveRef.current = true;  // ← バックグラウンドでも true にしてしまう
    isTabManagerActiveRef.current = false;
  }

  syncActiveTabRef.current();

  // Approach 4: 非表示なら再表示 ← ここが問題
  if (!isVisibleRef.current) {
    await appWindow.setPosition(new PhysicalPosition(0, 0));  // ← 意図しない再表示
    isVisibleRef.current = true;
  }
});
```

**AX Observer はエディタプロセスのみ監視しているため「AXイベント＝エディタがアクティブ」と仮定しているが、macOS はバックグラウンドアプリでも `AXFocusedWindowChanged` を送ることがある。** これが「たまに」発生する原因。

#### macOS が `AXFocusedWindowChanged` をバックグラウンドで発火するケース
- スリープ復帰時
- ウィンドウサーバーの内部状態変更時
- 複数エディタウィンドウ間の内部的なフォーカス再配置

### 副次的な原因

#### 副次原因1: 他アプリのウィンドウがエディタより小さい場合

`observer.rs` の `is_front_covering_editor()` は `front_width >= editor_width` で比較。小さいウィンドウのアプリ（Finder等）では `covers_editor=false` となり、そもそも非表示にならない。ただし、フルスクリーンブラウザでも発生するため、これだけでは説明がつかない。

#### 副次原因2: コールドスタート時の判定ギャップ

アプリにまだウィンドウがない場合、最初に `covers_editor=false` で emit。500msごとに最大4回リトライするが、その間タブバーが表示されたまま残る。

## 推奨・結論

### 修正方針

**`window-focus-changed` ハンドラで、エディタが本当にフォアグラウンドか確認してから再表示する。**

2つのアプローチ:

#### アプローチA: フロントエンド側でガード（シンプル）

```typescript
const unlistenWindowFocus = await listen("window-focus-changed", async () => {
  if (!isMounted) return;
  if (!isEditorActiveRef.current) return;  // ← ガード追加

  syncActiveTabRef.current();

  if (!isVisibleRef.current) {
    const appWindow = getCurrentWindow();
    await appWindow.setPosition(new PhysicalPosition(0, 0));
    isVisibleRef.current = true;
    // ...offset適用
  }
});
```

- メリット: 最小限の変更
- デメリット: Approach 6（observer.rsイベント取りこぼし時のフォールバック復帰）が効かなくなる

#### アプローチB: Rust側で frontmostApplication を確認してから emit（堅牢）

`ax_observer.rs` のコールバックで、`window-focus-changed` を emit する前に `frontmostApplication` がエディタかどうか確認する。

- メリット: Approach 6 のフォールバック機能を維持しつつ、誤発火を防げる
- デメリット: Rust側の変更が必要、AppleScript呼び出しのコストあり

### 推奨

**アプローチB を推奨。** Approach 6 はイベント取りこぼしの安全弁として重要な役割を持っているため、この機能を殺さずに修正するのが望ましい。Rust側で `NSWorkspace.shared.frontmostApplication` を同期的にチェックするのは低コスト（AppleScript不要、Cocoa API直接呼び出し）。

## 次のステップ
- `/spec` で修正仕様を作成し、アプローチBで実装へ進む
