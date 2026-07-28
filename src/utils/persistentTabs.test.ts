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

  it("matches same-named unresolved worktrees by their saved runtime identity", () => {
    const saved: SavedTab[] = [
      {
        runtime_id: "zed:100",
        name: "project",
        path: "/worktrees/one/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      },
      {
        runtime_id: "zed:200",
        name: "project",
        path: "/worktrees/two/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      },
    ];
    const live = [
      makeWindow({
        id: 200,
        runtime_id: "zed:200",
        name: "project",
        path: "",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
        resolution: "unresolved",
      }),
      makeWindow({
        id: 100,
        runtime_id: "zed:100",
        name: "project",
        path: "",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
        resolution: "unresolved",
      }),
    ];

    const result = reconcilePersistentTabs(saved, live);

    expect(result.tabs).toHaveLength(2);
    expect(result.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 100,
        runtime_id: "zed:100",
        path: "/worktrees/one/project",
        is_open: true,
      }),
      expect.objectContaining({
        id: 200,
        runtime_id: "zed:200",
        path: "/worktrees/two/project",
        is_open: true,
      }),
    ]));
  });

  it("does not name-match one saved tab to multiple unresolved live windows", () => {
    const saved: SavedTab[] = [{
      name: "project",
      path: "/projects/project",
      bundle_id: "dev.zed.Zed",
      editor_name: "Zed",
    }];
    const live = [
      makeWindow({
        id: 100,
        runtime_id: "zed:100",
        name: "project",
        path: "",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
        resolution: "unresolved",
      }),
      makeWindow({
        id: 200,
        runtime_id: "zed:200",
        name: "project",
        path: "",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
        resolution: "unresolved",
      }),
    ];

    const result = reconcilePersistentTabs(saved, live);

    expect(result.tabs).toHaveLength(3);
    expect(result.tabs.filter((tab) => tab.is_open === false)).toHaveLength(1);
    expect(result.tabs.filter((tab) => tab.path === "")).toHaveLength(2);
  });

  it("does not name-match a remaining worktree after another matched by runtime identity", () => {
    const saved: SavedTab[] = [
      {
        runtime_id: "zed:100",
        name: "project",
        path: "/worktrees/one/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      },
      {
        name: "project",
        path: "/worktrees/two/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      },
    ];
    const live = [
      makeWindow({
        id: 100,
        runtime_id: "zed:100",
        name: "project",
        path: "",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
        resolution: "unresolved",
      }),
      makeWindow({
        id: 300,
        runtime_id: "zed:300",
        name: "project",
        path: "",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
        resolution: "unresolved",
      }),
    ];

    const result = reconcilePersistentTabs(saved, live);

    expect(result.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime_id: "zed:100",
        path: "/worktrees/one/project",
        is_open: true,
      }),
      expect.objectContaining({
        path: "/worktrees/two/project",
        is_open: false,
      }),
      expect.objectContaining({
        runtime_id: "zed:300",
        path: "",
        is_open: true,
      }),
    ]));
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

  it("stores a resolved live window runtime identity", () => {
    const result = reconcilePersistentTabs([], [
      makeWindow({ runtime_id: "vscode:10:20" }),
    ]);

    expect(result.savedTabs).toEqual([
      expect.objectContaining({ runtime_id: "vscode:10:20" }),
    ]);
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
    expect(savedTabsDiffer(
      [{ ...vscode, runtime_id: "vscode:1" }],
      [{ ...vscode, runtime_id: "vscode:2" }],
    )).toBe(true);
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

  it("updates stored metadata from the current project path", () => {
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
    }])).toEqual([{
      ...saved[0],
      branch: "other",
      repository_id: "/projects/other/.git",
      repository_name: "other",
    }]);
  });

  it("clears stored metadata when the project is no longer a Git repository", () => {
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
      branch: null,
      repository_id: null,
      repository_name: null,
    }])).toEqual([{
      ...saved[0],
      branch: undefined,
      repository_id: undefined,
      repository_name: undefined,
    }]);
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

  it("adds missing path-based tabs while preserving saved tabs", () => {
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
    )).toEqual([
      existing[0],
      {
        name: "other",
        path: "/projects/other",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      },
    ]);
  });

  it("restores a name-based legacy key from a unique matching history entry", () => {
    const bundleId = "com.microsoft.VSCode";

    expect(migrateLegacySavedTabs(
      [],
      [`${bundleId}:project`],
      [{
        name: "project",
        path: "/projects/project",
        bundleId,
        editorName: "VSCode",
        timestamp: 1,
      }],
    )).toEqual([{
      name: "project",
      path: "/projects/project",
      bundle_id: bundleId,
      editor_name: "VSCode",
    }]);
  });

  it("does not guess a name-based legacy key with ambiguous history paths", () => {
    const bundleId = "dev.zed.Zed";

    expect(migrateLegacySavedTabs(
      [],
      [`${bundleId}:project`],
      [
        {
          name: "project",
          path: "/worktrees/one/project",
          bundleId,
          editorName: "Zed",
          timestamp: 2,
        },
        {
          name: "project",
          path: "/worktrees/two/project",
          bundleId,
          editorName: "Zed",
          timestamp: 1,
        },
      ],
    )).toEqual([]);
  });
});
