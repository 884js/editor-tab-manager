import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EditorWindow, GroupAssignment, GroupDefinition, HistoryEntry, SavedTab, TabColorMap, WindowsSnapshot } from "../types/editor";
import { useEditorWindows } from "./useEditorWindows";

// Mock store functions directly
const mockLoadTabOrder = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
const mockLoadTabColors = vi.fn<() => Promise<TabColorMap>>().mockResolvedValue({});
const mockLoadSavedTabs = vi.fn<() => Promise<SavedTab[]>>().mockResolvedValue([]);
const mockLoadHistory = vi.fn<() => Promise<HistoryEntry[]>>().mockResolvedValue([]);
const mockSaveTabOrder = vi.fn().mockResolvedValue(undefined);
const mockSaveTabColors = vi.fn().mockResolvedValue(undefined);
const mockSaveSavedTabs = vi.fn().mockResolvedValue(undefined);
const mockLoadGroups = vi.fn<() => Promise<GroupDefinition[]>>().mockResolvedValue([]);
const mockSaveGroups = vi.fn().mockResolvedValue(undefined);
const mockLoadGroupAssignments = vi.fn<() => Promise<GroupAssignment>>().mockResolvedValue({});
const mockSaveGroupAssignments = vi.fn().mockResolvedValue(undefined);
const mockLoadCollapsedGroups = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
const mockSaveCollapsedGroups = vi.fn().mockResolvedValue(undefined);
const mockLoadGroupColors = vi.fn<() => Promise<Record<string, string>>>().mockResolvedValue({});
const mockSaveGroupColors = vi.fn().mockResolvedValue(undefined);
const defaultWindowKey = (w: EditorWindow) => `${w.bundle_id}:${w.path || w.name}`;
const mockWindowKey = vi.fn(defaultWindowKey);
const mockRuntimeWindowKey = vi.fn((w: EditorWindow) => w.runtime_id ?? `${w.bundle_id}:${w.id}`);
const mockSortWindowsByOrder = vi.fn((windows: EditorWindow[], _order: string[]) => [...windows]);
const mockMigrateResolvedWindowKeys = vi.fn(
  (order: string[], _current: EditorWindow[], _next: EditorWindow[]) => [...order],
);

vi.mock("../utils/store", () => ({
  loadTabOrder: (...args: unknown[]) => mockLoadTabOrder(...(args as [])),
  loadTabColors: (...args: unknown[]) => mockLoadTabColors(...(args as [])),
  loadSavedTabs: (...args: unknown[]) => mockLoadSavedTabs(...(args as [])),
  loadHistory: (...args: unknown[]) => mockLoadHistory(...(args as [])),
  saveTabOrder: (...args: unknown[]) => mockSaveTabOrder(...(args as [string[]])),
  saveTabColors: (...args: unknown[]) => mockSaveTabColors(...(args as [TabColorMap])),
  saveSavedTabs: (...args: unknown[]) => mockSaveSavedTabs(...(args as [SavedTab[]])),
  loadGroups: (...args: unknown[]) => mockLoadGroups(...(args as [])),
  saveGroups: (...args: unknown[]) => mockSaveGroups(...args),
  loadGroupAssignments: (...args: unknown[]) => mockLoadGroupAssignments(...(args as [])),
  saveGroupAssignments: (...args: unknown[]) => mockSaveGroupAssignments(...args),
  loadCollapsedGroups: (...args: unknown[]) => mockLoadCollapsedGroups(...(args as [])),
  saveCollapsedGroups: (...args: unknown[]) => mockSaveCollapsedGroups(...args),
  loadGroupColors: (...args: unknown[]) => mockLoadGroupColors(...(args as [])),
  saveGroupColors: (...args: unknown[]) => mockSaveGroupColors(...args),
  normalizeProjectPath: (path: string) => path.length > 1 ? path.replace(/\/+$/, "") : path,
  legacyWindowKey: (w: EditorWindow) => `${w.bundle_id}:${w.name}`,
  windowKey: (w: EditorWindow) => mockWindowKey(w),
  runtimeWindowKey: (w: EditorWindow) => mockRuntimeWindowKey(w),
  migrateResolvedWindowKeys: (order: string[], current: EditorWindow[], next: EditorWindow[]) =>
    mockMigrateResolvedWindowKeys(order, current, next),
  sortWindowsByOrder: (windows: EditorWindow[], order: string[]) => mockSortWindowsByOrder(windows, order),
}));

function makeWindow(overrides: Partial<EditorWindow> = {}): EditorWindow {
  const name = overrides.name ?? "my-project";
  return {
    id: 1,
    name,
    path: overrides.path ?? `/Users/test/${name}`,
    bundle_id: "com.microsoft.VSCode",
    editor_name: "VSCode",
    ...overrides,
  };
}

type ListenHandler = (event: { payload: unknown }) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  const listeners = new Map<string, ListenHandler>();
  vi.mocked(listen).mockImplementation(async (event: string, handler: unknown) => {
    listeners.set(event, handler as ListenHandler);
    return () => {
      listeners.delete(event);
    };
  });

  const params = {
    dismissWaitingForWindow: vi.fn(),
    syncWaitingTimer: vi.fn(),
    addToHistory: vi.fn(),
    currentBundleIdRef: { current: "com.microsoft.VSCode" as string | null },
    isEditorActiveRef: { current: true },
    isTabManagerActiveRef: { current: false },
    isVisibleRef: { current: true },
    t: ((key: string) => key) as unknown as import("i18next").TFunction,
  };

  const { result, unmount } = renderHook(() => useEditorWindows(params));

  return { result, unmount, params, listeners };
}

describe("useEditorWindows", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockClear();
    mockLoadTabOrder.mockClear().mockResolvedValue([]);
    mockLoadTabColors.mockClear().mockResolvedValue({});
    mockLoadSavedTabs.mockClear().mockResolvedValue([]);
    mockLoadHistory.mockClear().mockResolvedValue([]);
    mockSaveTabOrder.mockClear().mockResolvedValue(undefined);
    mockSaveTabColors.mockClear().mockResolvedValue(undefined);
    mockSaveSavedTabs.mockClear().mockResolvedValue(undefined);
    mockLoadGroups.mockClear().mockResolvedValue([]);
    mockSaveGroups.mockClear().mockResolvedValue(undefined);
    mockLoadGroupAssignments.mockClear().mockResolvedValue({});
    mockSaveGroupAssignments.mockClear().mockResolvedValue(undefined);
    mockLoadCollapsedGroups.mockClear().mockResolvedValue([]);
    mockSaveCollapsedGroups.mockClear().mockResolvedValue(undefined);
    mockLoadGroupColors.mockClear().mockResolvedValue({});
    mockSaveGroupColors.mockClear().mockResolvedValue(undefined);
    mockWindowKey.mockClear().mockImplementation(defaultWindowKey);
    mockSortWindowsByOrder.mockClear().mockImplementation((windows) => [...windows]);
    mockRuntimeWindowKey.mockClear().mockImplementation(
      (window) => window.runtime_id ?? `${window.bundle_id}:${window.id}`,
    );
    mockMigrateResolvedWindowKeys.mockClear().mockImplementation((order) => [...order]);
  });

  it("starts with empty windows and activeIndex 0", () => {
    const { result } = setup();
    expect(result.current.windows).toEqual([]);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.tabColors).toEqual({});
  });

  it("opens a new window with the editor selected in the add menu", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { result } = setup();

    await act(async () => {
      await result.current.handleNewTab("com.todesktop.230313mzl4w4u92");
    });

    expect(invoke).toHaveBeenCalledWith("open_new_editor", {
      bundle_id: "com.todesktop.230313mzl4w4u92",
    });
  });

  describe("fetchWindows", () => {
    it("loads order + colors + windows on first call", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      vi.mocked(invoke).mockResolvedValue([win1, win2]);

      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(mockLoadTabOrder).toHaveBeenCalledOnce();
      expect(mockLoadTabColors).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith("get_windows_snapshot");
      expect(result.current.windows).toHaveLength(2);
    });

    it("caches order after first load", async () => {
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });
      await act(async () => {
        await result.current.fetchWindows();
      });

      // loadTabOrder should only be called once (cached)
      expect(mockLoadTabOrder).toHaveBeenCalledOnce();
    });

    it("restores saved tabs when no editor window is open", async () => {
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(result.current.windows).toEqual([
        expect.objectContaining({
          name: "saved-project",
          path: "/projects/saved-project",
          is_open: false,
        }),
      ]);
    });

    it("restores missing Git metadata from a saved tab path", async () => {
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/worktrees/feature/saved-project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      }]);
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "get_project_metadata") {
          return [{
            path: "/worktrees/feature/saved-project",
            branch: "feature/saved-tab",
            repository_id: "/projects/saved-project/.git",
            repository_name: "saved-project",
          }];
        }
        return [];
      });
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(invoke).toHaveBeenCalledWith("get_project_metadata", {
        paths: ["/worktrees/feature/saved-project"],
      });
      expect(result.current.windows).toEqual([
        expect.objectContaining({
          branch: "feature/saved-tab",
          repository_id: "/projects/saved-project/.git",
          repository_name: "saved-project",
          is_open: false,
        }),
      ]);
      expect(mockSaveSavedTabs).toHaveBeenCalledWith([
        expect.objectContaining({
          branch: "feature/saved-tab",
          repository_id: "/projects/saved-project/.git",
          repository_name: "saved-project",
        }),
      ]);
    });

    it("refreshes stored Git metadata even when every field already exists", async () => {
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/worktrees/feature/saved-project",
        branch: "feature/old",
        repository_id: "/projects/old/.git",
        repository_name: "old",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      }]);
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "get_project_metadata") {
          return [{
            path: "/worktrees/feature/saved-project",
            branch: "feature/current",
            repository_id: "/projects/saved-project/.git",
            repository_name: "saved-project",
          }];
        }
        return [];
      });
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(invoke).toHaveBeenCalledWith("get_project_metadata", {
        paths: ["/worktrees/feature/saved-project"],
      });
      expect(result.current.windows).toEqual([
        expect.objectContaining({
          branch: "feature/current",
          repository_id: "/projects/saved-project/.git",
          repository_name: "saved-project",
          is_open: false,
        }),
      ]);
      expect(mockSaveSavedTabs).toHaveBeenCalledWith([
        expect.objectContaining({
          branch: "feature/current",
          repository_id: "/projects/saved-project/.git",
          repository_name: "saved-project",
        }),
      ]);
    });

    it("shows saved tabs before the initial window snapshot succeeds", async () => {
      const pendingSnapshot = deferred<WindowsSnapshot>();
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      vi.mocked(invoke).mockImplementation((command) => {
        if (command === "get_project_metadata") {
          return Promise.resolve([{
            path: "/projects/saved-project",
            branch: null,
            repository_id: null,
            repository_name: null,
          }]);
        }
        if (command === "get_windows_snapshot") {
          return pendingSnapshot.promise;
        }
        return Promise.resolve(undefined);
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { result } = setup();
      let fetchPromise!: Promise<number>;

      act(() => {
        fetchPromise = result.current.fetchWindows();
      });

      await waitFor(() => {
        expect(result.current.windows).toEqual([
          expect.objectContaining({
            path: "/projects/saved-project",
            is_open: false,
          }),
        ]);
      });

      pendingSnapshot.reject(new Error("snapshot failed"));
      await act(async () => {
        await fetchPromise;
      });
      expect(result.current.windows[0]).toEqual(
        expect.objectContaining({
          path: "/projects/saved-project",
          is_open: false,
        }),
      );
      consoleError.mockRestore();
    });

    it("migrates the previous tab order when saved tabs have not been created yet", async () => {
      mockLoadTabOrder.mockResolvedValue([
        "com.microsoft.VSCode:/projects/legacy-project",
      ]);
      mockLoadHistory.mockResolvedValue([{
        name: "legacy-project",
        path: "/projects/legacy-project",
        bundleId: "com.microsoft.VSCode",
        editorName: "VSCode",
        timestamp: 1,
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(result.current.windows).toEqual([
        expect.objectContaining({
          name: "legacy-project",
          is_open: false,
        }),
      ]);
      expect(mockSaveSavedTabs).toHaveBeenCalledWith([
        expect.objectContaining({
          path: "/projects/legacy-project",
          bundle_id: "com.microsoft.VSCode",
        }),
      ]);
    });

    it("recovers a legacy name-based order from a unique history entry", async () => {
      mockLoadTabOrder.mockResolvedValue([
        "com.microsoft.VSCode:legacy-project",
      ]);
      mockLoadHistory.mockResolvedValue([{
        name: "legacy-project",
        path: "/projects/legacy-project",
        bundleId: "com.microsoft.VSCode",
        editorName: "VSCode",
        timestamp: 1,
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(result.current.windows).toEqual([
        expect.objectContaining({
          path: "/projects/legacy-project",
          is_open: false,
        }),
      ]);
      expect(mockSaveTabOrder).toHaveBeenCalledWith([
        "com.microsoft.VSCode:/projects/legacy-project",
      ]);
    });

    it("recovers missing path-based order entries when saved tabs already exist", async () => {
      mockLoadTabOrder.mockResolvedValue([
        "com.microsoft.VSCode:/projects/saved-project",
        "dev.zed.Zed:/projects/legacy-project",
      ]);
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(result.current.windows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/projects/saved-project" }),
          expect.objectContaining({ path: "/projects/legacy-project" }),
        ]),
      );
      expect(mockSaveSavedTabs).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/projects/legacy-project",
            bundle_id: "dev.zed.Zed",
          }),
        ]),
      );
    });

    it("does not erase an unresolved legacy name-based order", async () => {
      mockLoadTabOrder.mockResolvedValue([
        "dev.zed.Zed:ambiguous-project",
      ]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(mockSaveTabOrder).not.toHaveBeenCalledWith([]);
      expect(mockSaveTabOrder).not.toHaveBeenCalled();
    });

    it("does not replace a legacy name order with an unresolved runtime key", async () => {
      const legacyKey = "dev.zed.Zed:ambiguous-project";
      const unresolved = makeWindow({
        id: 42,
        runtime_id: "dev.zed.Zed:100:42",
        name: "ambiguous-project",
        path: "",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
        resolution: "unresolved",
      });
      mockWindowKey.mockImplementation((window) =>
        window.path
          ? `${window.bundle_id}:${window.path}`
          : `${window.bundle_id}:runtime:${mockRuntimeWindowKey(window)}`
      );
      mockLoadTabOrder.mockResolvedValue([legacyKey]);
      vi.mocked(invoke).mockResolvedValue([unresolved]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(mockSaveTabOrder).toHaveBeenCalledWith([
        legacyKey,
        "dev.zed.Zed:runtime:dev.zed.Zed:100:42",
      ]);
    });

    it("adjusts activeIndex when it exceeds window count", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      vi.mocked(invoke).mockResolvedValue([win1, win2]);

      const { result } = setup();

      // First fetch 2 windows
      await act(async () => {
        await result.current.fetchWindows();
      });

      // Manually set activeIndex high
      act(() => {
        result.current.handleTabClick(1);
      });

      // Now fetch with only 1 window
      vi.mocked(invoke).mockResolvedValue([win1]);

      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(result.current.activeIndex).toBeLessThan(2);
    });
  });

  describe("refreshWindows", () => {
    it("fetches and sorts windows", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      vi.mocked(invoke).mockResolvedValue([win1]);

      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(invoke).toHaveBeenCalledWith("get_windows_snapshot");
      expect(result.current.windows).toHaveLength(1);
    });

    it("adds disappeared windows to history", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha", path: "/path/alpha" });
      const win2 = makeWindow({ id: 2, name: "beta", path: "/path/beta" });

      vi.mocked(invoke).mockResolvedValue([win1, win2]);
      const { result, params } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      // Now only win1 exists
      vi.mocked(invoke).mockResolvedValue([win1]);

      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(params.addToHistory).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: "beta" })])
      );
    });

    it("keeps a tab after its editor window closes", async () => {
      const win = makeWindow({ id: 1, name: "alpha", path: "/path/alpha" });
      vi.mocked(invoke).mockResolvedValue([win]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      vi.mocked(invoke).mockResolvedValue([]);
      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(result.current.windows).toEqual([
        expect.objectContaining({
          name: "alpha",
          path: "/path/alpha",
          is_open: false,
        }),
      ]);
    });

    it("updates a same-named window when its worktree path changes", async () => {
      const first = makeWindow({ id: 1, name: "project", path: "/worktrees/one/project" });
      const second = makeWindow({ id: 1, name: "project", path: "/worktrees/two/project" });
      vi.mocked(invoke).mockResolvedValue([first]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      vi.mocked(invoke).mockResolvedValue([second]);
      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(result.current.windows[0].path).toBe("/worktrees/two/project");
    });

    it("updates a window when repository metadata becomes available", async () => {
      const initial = makeWindow({ repository_id: undefined, repository_name: undefined });
      const resolved = makeWindow({
        repository_id: "/projects/project/.git",
        repository_name: "project",
      });
      vi.mocked(invoke).mockResolvedValue([initial]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      vi.mocked(invoke).mockResolvedValue([resolved]);
      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(result.current.windows[0]).toMatchObject({
        repository_id: "/projects/project/.git",
        repository_name: "project",
      });
    });

    it("updates the window id when the same worktree is reopened", async () => {
      const first = makeWindow({ id: 1, name: "project", path: "/worktrees/one/project" });
      const reopened = makeWindow({ id: 2, name: "project", path: "/worktrees/one/project" });
      vi.mocked(invoke).mockResolvedValue([first]);
      const { result, params } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      vi.mocked(invoke).mockResolvedValue([reopened]);
      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(result.current.windows[0].id).toBe(2);
      expect(params.addToHistory).not.toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ path: first.path })]),
      );
    });

    it("persists the tab order when a runtime-only window resolves to a path", async () => {
      const unresolved = makeWindow({
        id: 1,
        runtime_id: "cursor:42",
        name: "project",
        path: "",
      });
      const resolved = makeWindow({
        id: 1,
        runtime_id: "cursor:42",
        name: "project",
        path: "/worktrees/two/project",
      });
      mockLoadTabOrder.mockResolvedValue(["runtime-order-key"]);
      vi.mocked(invoke).mockResolvedValue([unresolved]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      mockSaveTabOrder.mockClear();
      mockMigrateResolvedWindowKeys.mockReturnValue(["resolved-order-key"]);
      vi.mocked(invoke).mockResolvedValue([resolved]);
      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(mockSaveTabOrder).toHaveBeenCalledWith(["resolved-order-key"]);
    });

    it.each(["refreshWindows", "fetchWindows"] as const)(
      "ignores a stale %s response after a newer snapshot event",
      async (method) => {
        const initial = makeWindow({ id: 1, name: "initial" });
        const stale = makeWindow({ id: 2, name: "stale" });
        const current = makeWindow({ id: 3, name: "current" });
        const pendingSnapshot = deferred<WindowsSnapshot>();
        let snapshotCallCount = 0;
        vi.mocked(invoke).mockImplementation((command) => {
          if (command !== "get_windows_snapshot") {
            return Promise.resolve(undefined);
          }
          snapshotCallCount += 1;
          if (snapshotCallCount === 1) {
            return Promise.resolve({
              revision: 1,
              windows: [initial],
              active_id: initial.id,
              source: "test",
            });
          }
          return pendingSnapshot.promise;
        });
        const { result, listeners } = setup();

        await act(async () => {
          await result.current.fetchWindows();
        });
        await waitFor(() => expect(listeners.has("windows:snapshot")).toBe(true));

        let requestPromise!: Promise<void> | Promise<number>;
        act(() => {
          requestPromise = result.current[method]();
        });
        await waitFor(() => expect(snapshotCallCount).toBe(2));

        act(() => {
          listeners.get("windows:snapshot")!({
            payload: {
              revision: 3,
              windows: [current],
              active_id: current.id,
              source: "test",
            },
          });
        });
        pendingSnapshot.resolve({
          revision: 2,
          windows: [stale],
          active_id: stale.id,
          source: "test",
        });
        await act(async () => {
          await requestPromise;
        });

        expect(result.current.windows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "current", is_open: true }),
            expect.objectContaining({ name: "initial", is_open: false }),
          ]),
        );
        expect(result.current.windows).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "stale" })]),
        );
      },
    );

    it("does not reapply an already handled structured snapshot revision", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      const snapshot: WindowsSnapshot = {
        revision: 5,
        windows: [win1, win2],
        active_id: win1.id,
        source: "test",
      };
      vi.mocked(invoke).mockImplementation((command) => {
        if (command === "get_windows_snapshot") {
          return Promise.resolve(snapshot);
        }
        return Promise.resolve(undefined);
      });
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });
      act(() => {
        result.current.handleReorder(0, 1);
      });

      await act(async () => {
        await result.current.fetchWindows();
      });

      expect(result.current.windows.map((window) => window.name)).toEqual([
        "beta",
        "alpha",
      ]);
    });
  });

  describe("syncActiveTab", () => {
    it("syncs active tab with frontmost window", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      const snapshot: WindowsSnapshot = {
        revision: 1,
        windows: [win1, win2],
        active_id: win2.id,
        source: "test",
      };
      vi.mocked(invoke).mockResolvedValue(snapshot);
      const { result, params } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });
      expect(result.current.activeIndex).toBe(0);

      await act(async () => {
        await result.current.syncActiveTab();
      });

      expect(result.current.activeIndex).toBe(1);
      expect(params.syncWaitingTimer).toHaveBeenCalled();
    });

    it("respects 200ms debounce after tab click", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });

      vi.mocked(invoke).mockResolvedValue([win1, win2]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      // Click a tab (sets lastTabClickTime)
      vi.mocked(invoke).mockResolvedValue(undefined);
      act(() => {
        result.current.handleTabClick(1);
      });

      // Immediately try to sync — should be debounced
      const snapshot: WindowsSnapshot = {
        revision: 1,
        windows: [win1, win2],
        active_id: win1.id,
        source: "test",
      };
      vi.mocked(invoke).mockResolvedValue(snapshot);

      await act(async () => {
        await result.current.syncActiveTab();
      });

      // Active index should NOT have changed back to 0
      expect(result.current.activeIndex).toBe(1);
    });

    it("ignores a stale active-window snapshot after a newer event", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      const pendingSnapshot = deferred<WindowsSnapshot>();
      let snapshotCallCount = 0;
      vi.mocked(invoke).mockImplementation((command) => {
        if (command !== "get_windows_snapshot") {
          return Promise.resolve(undefined);
        }
        snapshotCallCount += 1;
        if (snapshotCallCount === 1) {
          return Promise.resolve({
            revision: 1,
            windows: [win1, win2],
            active_id: win1.id,
            source: "test",
          });
        }
        return pendingSnapshot.promise;
      });
      const { result, listeners } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });
      await waitFor(() => expect(listeners.has("windows:snapshot")).toBe(true));

      let syncPromise!: Promise<void>;
      act(() => {
        syncPromise = result.current.syncActiveTab();
      });
      await waitFor(() => expect(snapshotCallCount).toBe(2));

      act(() => {
        listeners.get("windows:snapshot")!({
          payload: {
            revision: 3,
            windows: [win1, win2],
            active_id: win2.id,
            source: "test",
          },
        });
      });
      pendingSnapshot.resolve({
        revision: 2,
        windows: [win1, win2],
        active_id: win1.id,
        source: "test",
      });
      await act(async () => {
        await syncPromise;
      });

      expect(result.current.activeIndex).toBe(1);
    });
  });

  describe("handleTabClick", () => {
    it("updates activeIndex and focuses the window", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });

      vi.mocked(invoke).mockResolvedValue([win1, win2]);
      const { result, params } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      vi.mocked(invoke).mockResolvedValue(undefined);
      act(() => {
        result.current.handleTabClick(1);
      });

      expect(result.current.activeIndex).toBe(1);
      expect(params.dismissWaitingForWindow).toHaveBeenCalledWith(
        expect.objectContaining(win2),
      );
      expect(invoke).toHaveBeenCalledWith("focus_editor_window", {
        bundle_id: win2.bundle_id,
        window_id: win2.id,
      });
    });

    it("does nothing when clicking the already active tab", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      vi.mocked(invoke).mockResolvedValue([win1]);

      const { result, params } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      vi.mocked(invoke).mockClear();
      act(() => {
        result.current.handleTabClick(0);
      });

      expect(invoke).not.toHaveBeenCalledWith("focus_editor_window", expect.anything());
      expect(params.dismissWaitingForWindow).not.toHaveBeenCalled();
    });

    it("reopens a saved tab in the selected editor", async () => {
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      vi.mocked(invoke).mockClear();
      vi.mocked(invoke).mockResolvedValue(undefined);
      await act(async () => {
        await result.current.handleOpenSavedTab(0, "com.todesktop.230313mzl4w4u92");
      });

      expect(invoke).toHaveBeenCalledWith("open_project_in_editor", {
        bundle_id: "com.todesktop.230313mzl4w4u92",
        path: "/projects/saved-project",
      });
      expect(mockSaveSavedTabs).toHaveBeenCalledWith([
        expect.objectContaining({
          path: "/projects/saved-project",
          bundle_id: "com.todesktop.230313mzl4w4u92",
        }),
      ]);
    });

    it("preserves the group when reopening a saved tab in another editor", async () => {
      const sourceKey = "com.microsoft.VSCode:/projects/saved-project";
      const targetKey = "com.todesktop.230313mzl4w4u92:/projects/saved-project";
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      mockLoadGroupAssignments.mockResolvedValue({
        [sourceKey]: "group-1",
      });
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      vi.mocked(invoke).mockResolvedValue(undefined);
      await act(async () => {
        await result.current.handleOpenSavedTab(0, "com.todesktop.230313mzl4w4u92");
      });

      expect(result.current.groupAssignments).toEqual({
        [targetKey]: "group-1",
      });
      expect(mockSaveGroupAssignments).toHaveBeenCalledWith({
        [targetKey]: "group-1",
      });
    });

    it("uses the displayed group when reopening an inherited grouped tab", async () => {
      const targetKey = "dev.zed.Zed:/projects/saved-project";
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      vi.mocked(invoke).mockResolvedValue(undefined);
      await act(async () => {
        await result.current.handleOpenSavedTab(0, "dev.zed.Zed", "group-1");
      });

      expect(result.current.groupAssignments).toEqual({
        [targetKey]: "group-1",
      });
      expect(mockSaveGroupAssignments).toHaveBeenCalledWith({
        [targetKey]: "group-1",
      });
    });

    it("marks a saved tab when reopening it fails", async () => {
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(invoke).mockRejectedValue(new Error("open failed"));
      await act(async () => {
        await result.current.handleOpenSavedTab(0, "dev.zed.Zed");
      });

      expect(result.current.windows[0].open_error).toBe(true);
      expect(result.current.windows[0].bundle_id).toBe("dev.zed.Zed");
      consoleError.mockRestore();
    });

    it("does not reopen a saved tab until an editor is selected", async () => {
      mockLoadSavedTabs.mockResolvedValue([{
        name: "saved-project",
        path: "/projects/saved-project",
        bundle_id: "com.microsoft.VSCode",
        editor_name: "VSCode",
      }]);
      vi.mocked(invoke).mockResolvedValue([]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      vi.mocked(invoke).mockClear();
      act(() => {
        result.current.handleTabClick(0);
      });

      expect(invoke).not.toHaveBeenCalledWith("open_project_in_editor", expect.anything());
    });

    it("focuses an existing selected-editor window and merges the closed duplicate", async () => {
      const path = "/projects/shared-project";
      mockLoadSavedTabs.mockResolvedValue([
        {
          name: "shared-project",
          path,
          bundle_id: "com.microsoft.VSCode",
          editor_name: "VSCode",
        },
        {
          name: "shared-project",
          path,
          bundle_id: "com.todesktop.230313mzl4w4u92",
          editor_name: "Cursor",
        },
      ]);
      const cursorWindow = makeWindow({
        id: 2,
        name: "shared-project",
        path,
        bundle_id: "com.todesktop.230313mzl4w4u92",
        editor_name: "Cursor",
      });
      vi.mocked(invoke).mockResolvedValue([cursorWindow]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });

      const closedIndex = result.current.windows.findIndex(
        (window) => window.bundle_id === "com.microsoft.VSCode",
      );
      vi.mocked(invoke).mockClear();
      vi.mocked(invoke).mockResolvedValue(undefined);

      await act(async () => {
        await result.current.handleOpenSavedTab(
          closedIndex,
          "com.todesktop.230313mzl4w4u92",
        );
      });

      expect(invoke).toHaveBeenCalledWith("focus_editor_window", {
        bundle_id: "com.todesktop.230313mzl4w4u92",
        window_id: 2,
      });
      expect(invoke).not.toHaveBeenCalledWith("open_project_in_editor", expect.anything());
      expect(result.current.windows).toHaveLength(1);
    });
  });

  describe("handleReorder", () => {
    it("reorders windows and saves to Store", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      const win3 = makeWindow({ id: 3, name: "gamma" });

      vi.mocked(invoke).mockResolvedValue([win1, win2, win3]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      act(() => {
        result.current.handleReorder(0, 2);
      });

      expect(result.current.windows[0].name).toBe("beta");
      expect(result.current.windows[1].name).toBe("gamma");
      expect(result.current.windows[2].name).toBe("alpha");
      expect(mockSaveTabOrder).toHaveBeenCalled();
    });

    it("preserves an unresolved legacy order when reordering tabs", async () => {
      const legacyKey = "dev.zed.Zed:project";
      const win1 = makeWindow({
        id: 1,
        name: "project",
        path: "/worktrees/one/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      });
      const win2 = makeWindow({
        id: 2,
        name: "project",
        path: "/worktrees/two/project",
        bundle_id: "dev.zed.Zed",
        editor_name: "Zed",
      });
      mockLoadTabOrder.mockResolvedValue([legacyKey]);
      vi.mocked(invoke).mockResolvedValue([win1, win2]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });
      mockSaveTabOrder.mockClear();

      act(() => {
        result.current.handleReorder(0, 1);
      });

      expect(mockSaveTabOrder).toHaveBeenCalledWith([
        legacyKey,
        defaultWindowKey(win2),
        defaultWindowKey(win1),
      ]);
    });

    it("preserves an unresolved legacy order when applying visual order", async () => {
      const legacyKey = "dev.zed.Zed:unresolved-project";
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      mockLoadTabOrder.mockResolvedValue([legacyKey]);
      vi.mocked(invoke).mockResolvedValue([win1, win2]);
      const { result } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });
      mockSaveTabOrder.mockClear();

      act(() => {
        result.current.handleReorderByVisual([1, 0]);
      });

      expect(mockSaveTabOrder).toHaveBeenCalledWith([
        legacyKey,
        defaultWindowKey(win2),
        defaultWindowKey(win1),
      ]);
    });

    it("updates activeIndex when the active tab is moved", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });
      const win3 = makeWindow({ id: 3, name: "gamma" });

      vi.mocked(invoke).mockResolvedValue([win1, win2, win3]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      // Active tab is index 0, move it to index 2
      act(() => {
        result.current.handleReorder(0, 2);
      });

      expect(result.current.activeIndex).toBe(2);
    });

    it("ignores out of bounds", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      vi.mocked(invoke).mockResolvedValue([win1]);
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });
      mockSaveTabOrder.mockClear();

      act(() => {
        result.current.handleReorder(-1, 0);
      });

      // Should not crash, windows unchanged
      expect(result.current.windows).toHaveLength(1);
      expect(mockSaveTabOrder).not.toHaveBeenCalled();
    });
  });

  describe("handleColorChange", () => {
    it("sets a tab color and saves to Store", async () => {
      const { result } = setup();

      act(() => {
        result.current.handleColorChange("alpha", "red");
      });

      expect(result.current.tabColors).toEqual({ alpha: "red" });
      expect(mockSaveTabColors).toHaveBeenCalledWith({ alpha: "red" });
    });

    it("removes a color when null is passed", async () => {
      const { result } = setup();

      act(() => {
        result.current.handleColorChange("alpha", "red");
      });

      act(() => {
        result.current.handleColorChange("alpha", null);
      });

      expect(result.current.tabColors.alpha).toBeNull();
    });

    it("stores colors separately for same-named worktrees", () => {
      const { result } = setup();
      const firstKey = "com.microsoft.VSCode:/worktrees/one/project";
      const secondKey = "com.microsoft.VSCode:/worktrees/two/project";

      act(() => {
        result.current.handleColorChange(firstKey, "red");
        result.current.handleColorChange(secondKey, "blue");
      });

      expect(result.current.tabColors).toEqual({
        [firstKey]: "red",
        [secondKey]: "blue",
      });
    });
  });

  describe("group assignments", () => {
    it("stores an explicit unassignment for a path-specific tab", () => {
      const { result } = setup();
      const key = "com.microsoft.VSCode:/worktrees/one/project";

      act(() => {
        result.current.assignTabsToGroup([key], "group-a");
        result.current.unassignTabsFromGroup([key]);
      });

      expect(result.current.groupAssignments[key]).toBeNull();
      expect(mockSaveGroupAssignments).toHaveBeenLastCalledWith({ [key]: null });
    });

    it("updates repository window assignments in one batch", () => {
      const { result } = setup();
      const keys = [
        "com.microsoft.VSCode:/worktrees/project",
        "com.todesktop.230313mzl4w4u92:/projects/project",
      ];

      act(() => {
        result.current.assignTabsToGroup(keys, "group-a");
      });

      expect(result.current.groupAssignments).toMatchObject({
        [keys[0]]: "group-a",
        [keys[1]]: "group-a",
      });
      expect(mockSaveGroupAssignments).toHaveBeenLastCalledWith({
        [keys[0]]: "group-a",
        [keys[1]]: "group-a",
      });

      act(() => {
        result.current.unassignTabsFromGroup(keys);
      });

      expect(result.current.groupAssignments).toMatchObject({
        [keys[0]]: null,
        [keys[1]]: null,
      });
    });
  });

  describe("event listeners", () => {
    it("sets up switch-to-tab listener", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });

      vi.mocked(invoke).mockResolvedValue([win1, win2]);
      const { result, listeners } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      await waitFor(() => expect(listeners.has("switch-to-tab")).toBe(true));

      vi.mocked(invoke).mockResolvedValue(undefined);
      act(() => {
        listeners.get("switch-to-tab")!({ payload: 1 });
      });

      expect(result.current.activeIndex).toBe(1);
    });

    it("sets up windows:snapshot listener", async () => {
      const { listeners } = setup();
      await waitFor(() => expect(listeners.has("windows:snapshot")).toBe(true));
    });

    it("ignores an older snapshot revision", async () => {
      const current = makeWindow({ id: 1, name: "current" });
      const stale = makeWindow({ id: 2, name: "stale" });
      const snapshot: WindowsSnapshot = {
        revision: 2,
        windows: [current],
        active_id: current.id,
        source: "test",
      };
      vi.mocked(invoke).mockResolvedValue(snapshot);
      const { result, listeners } = setup();

      await act(async () => {
        await result.current.fetchWindows();
      });
      await waitFor(() => expect(listeners.has("windows:snapshot")).toBe(true));

      act(() => {
        listeners.get("windows:snapshot")!({
          payload: {
            revision: 1,
            windows: [stale],
            active_id: stale.id,
            source: "test",
          },
        });
      });

      expect(result.current.windows[0].name).toBe("current");
    });

    it("cleans up listeners on unmount", async () => {
      const { unmount, listeners } = setup();

      await waitFor(() => expect(listeners.size).toBeGreaterThan(0));

      unmount();
      expect(listeners.size).toBe(0);
    });
  });
});
