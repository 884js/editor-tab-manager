import type { EditorWindow, SavedTab } from "../types/editor";
import {
  migrateLegacySavedTabs,
  migrateSavedTabKeys,
  mergeProjectMetadata,
  reconcilePersistentTabs,
  savedTabsDiffer,
} from "./persistentTabs";

function makeWindow(overrides: Partial<EditorWindow> = {}): EditorWindow {
  return {
    id: 1,
    name: "project",
    path: "/projects/project",
    bundle_id: "com.microsoft.VSCode",
    editor_name: "VSCode",
    ...overrides,
  };
}

describe("reconcilePersistentTabs", () => {
  it("keeps a saved tab when its editor window is closed", () => {
    const saved: SavedTab[] = [{
      name: "project",
      path: "/projects/project",
      bundle_id: "com.microsoft.VSCode",
      editor_name: "VSCode",
    }];

    const result = reconcilePersistentTabs(saved, []);

    expect(result.tabs).toEqual([
      expect.objectContaining({
        path: "/projects/project",
        bundle_id: "com.microsoft.VSCode",
        is_open: false,
      }),
    ]);
  });

  it("stores the same project separately for different editors", () => {
    const result = reconcilePersistentTabs([], [
      makeWindow(),
      makeWindow({
        id: 2,
        bundle_id: "com.todesktop.230313mzl4w4u92",
        editor_name: "Cursor",
      }),
    ]);

    expect(result.savedTabs).toHaveLength(2);
    expect(result.tabs).toEqual([
      expect.objectContaining({ bundle_id: "com.microsoft.VSCode", is_open: true }),
      expect.objectContaining({
        bundle_id: "com.todesktop.230313mzl4w4u92",
        is_open: true,
      }),
    ]);
  });

  it("does not persist a window whose project path is unresolved", () => {
    const unresolved = makeWindow({ path: "", resolution: "unresolved" });

    const result = reconcilePersistentTabs([], [unresolved]);

    expect(result.savedTabs).toEqual([]);
    expect(result.tabs).toEqual([
      expect.objectContaining({ path: "", is_open: true }),
    ]);
  });

  it("matches a uniquely named unresolved window to its saved tab", () => {
    const saved: SavedTab[] = [{
      name: "wishlist",
      path: "/projects/wishlist",
      bundle_id: "dev.zed.Zed",
      editor_name: "Zed",
    }];
    const unresolved = makeWindow({
      id: 2,
      runtime_id: "zed:2",
      name: "wishlist",
      path: "",
      bundle_id: "dev.zed.Zed",
      editor_name: "Zed",
      resolution: "unresolved",
    });

    const result = reconcilePersistentTabs(saved, [unresolved]);

    expect(result.savedTabs).toHaveLength(1);
    expect(result.tabs).toEqual([
      expect.objectContaining({
        id: 2,
        runtime_id: "zed:2",
        path: "/projects/wishlist",
        bundle_id: "dev.zed.Zed",
        is_open: true,
      }),
    ]);
  });

  it("keeps an unresolved window separate when multiple saved tabs have its name", () => {
    const saved: SavedTab[] = [
      {
        name: "project",
        path: "/projects/one/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      },
      {
        name: "project",
        path: "/projects/two/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      },
    ];
    const unresolved = makeWindow({
      path: "",
      bundle_id: "dev.zed.Zed",
      editor_name: "Zed",
      resolution: "unresolved",
    });

    const result = reconcilePersistentTabs(saved, [unresolved]);

    expect(result.savedTabs).toHaveLength(2);
    expect(result.tabs).toHaveLength(3);
    expect(result.tabs.filter((tab) => tab.is_open === false)).toHaveLength(2);
    expect(result.tabs).toContainEqual(
      expect.objectContaining({ path: "", is_open: true }),
    );
  });
});

describe("migrateSavedTabKeys", () => {
  it("replaces a saved path when the same runtime window resolves elsewhere", () => {
    const current = makeWindow({
      runtime_id: "cursor:42",
      path: "/worktrees/old/project",
    });
    const next = makeWindow({
      runtime_id: "cursor:42",
      path: "/worktrees/current/project",
    });
    const saved: SavedTab[] = [{
      name: current.name,
      path: current.path,
      bundle_id: current.bundle_id,
      editor_name: current.editor_name,
    }];

    expect(migrateSavedTabKeys(saved, [current], [next])).toEqual([]);
  });
});

describe("savedTabsDiffer", () => {
  it("detects editor-specific tab changes", () => {
    const vscode: SavedTab = {
      name: "project",
      path: "/projects/project",
      bundle_id: "com.microsoft.VSCode",
      editor_name: "VSCode",
    };
    const cursor = {
      ...vscode,
      bundle_id: "com.todesktop.230313mzl4w4u92",
      editor_name: "Cursor",
    };

    expect(savedTabsDiffer([vscode], [cursor])).toBe(true);
    expect(savedTabsDiffer([vscode], [vscode])).toBe(false);
  });
});

describe("mergeProjectMetadata", () => {
  it("restores missing branch and repository fields from a saved path", () => {
    const saved: SavedTab[] = [{
      name: "project",
      path: "/worktrees/feature/project",
      bundle_id: "dev.zed.Zed",
      editor_name: "Zed",
    }];

    expect(mergeProjectMetadata(saved, [{
      path: "/worktrees/feature/project",
      branch: "feature/saved-tab",
      repository_id: "/projects/project/.git",
      repository_name: "project",
    }])).toEqual([
      expect.objectContaining({
        branch: "feature/saved-tab",
        repository_id: "/projects/project/.git",
        repository_name: "project",
      }),
    ]);
  });

  it("preserves metadata already stored on the tab", () => {
    const saved: SavedTab[] = [{
      name: "project",
      path: "/projects/project",
      branch: "current",
      repository_id: "/projects/project/.git",
      repository_name: "project",
      bundle_id: "com.microsoft.VSCode",
      editor_name: "VSCode",
    }];

    expect(mergeProjectMetadata(saved, [{
      path: "/projects/project",
      branch: "other",
      repository_id: "/projects/other/.git",
      repository_name: "other",
    }])).toEqual(saved);
  });
});

describe("migrateLegacySavedTabs", () => {
  it("restores path-based tabs in their previous order", () => {
    const order = [
      "com.todesktop.230313mzl4w4u92:/projects/beta",
      "com.microsoft.VSCode:/projects/alpha",
      "com.openai.codex:runtime:com.openai.codex:1:2",
    ];

    const result = migrateLegacySavedTabs([], order, [{
      name: "beta-project",
      path: "/projects/beta",
      bundleId: "com.todesktop.230313mzl4w4u92",
      editorName: "Cursor",
      timestamp: 1,
    }]);

    expect(result).toEqual([
      {
        name: "beta-project",
        path: "/projects/beta",
        bundle_id: "com.todesktop.230313mzl4w4u92",
        editor_name: "Cursor",
      },
      {
        name: "alpha",
        path: "/projects/alpha",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      },
    ]);
  });

  it("does not rerun migration after saved tabs exist", () => {
    const existing: SavedTab[] = [{
      name: "project",
      path: "/projects/project",
      bundle_id: "com.microsoft.VSCode",
      editor_name: "VSCode",
    }];

    expect(migrateLegacySavedTabs(
      existing,
      ["com.microsoft.VSCode:/projects/other"],
      [],
    )).toBe(existing);
  });
});
