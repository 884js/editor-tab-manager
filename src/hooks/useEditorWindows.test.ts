import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EditorWindow, EditorState, GroupAssignment, GroupDefinition, TabColorMap } from "../types/editor";
import { useEditorWindows } from "./useEditorWindows";

// Mock store functions directly
const mockLoadTabOrder = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
const mockLoadTabColors = vi.fn<() => Promise<TabColorMap>>().mockResolvedValue({});
const mockSaveTabOrder = vi.fn().mockResolvedValue(undefined);
const mockSaveTabColors = vi.fn().mockResolvedValue(undefined);
const mockLoadGroups = vi.fn<() => Promise<GroupDefinition[]>>().mockResolvedValue([]);
const mockSaveGroups = vi.fn().mockResolvedValue(undefined);
const mockLoadGroupAssignments = vi.fn<() => Promise<GroupAssignment>>().mockResolvedValue({});
const mockSaveGroupAssignments = vi.fn().mockResolvedValue(undefined);
const mockLoadCollapsedGroups = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
const mockSaveCollapsedGroups = vi.fn().mockResolvedValue(undefined);
const mockLoadGroupColors = vi.fn<() => Promise<Record<string, string>>>().mockResolvedValue({});
const mockSaveGroupColors = vi.fn().mockResolvedValue(undefined);
const mockWindowKey = vi.fn((w: EditorWindow) => `${w.bundle_id}:${w.path || w.name}`);
const mockSortWindowsByOrder = vi.fn((windows: EditorWindow[], _order: string[]) => [...windows]);

vi.mock("../utils/store", () => ({
  loadTabOrder: (...args: unknown[]) => mockLoadTabOrder(...(args as [])),
  loadTabColors: (...args: unknown[]) => mockLoadTabColors(...(args as [])),
  saveTabOrder: (...args: unknown[]) => mockSaveTabOrder(...(args as [string[]])),
  saveTabColors: (...args: unknown[]) => mockSaveTabColors(...(args as [TabColorMap])),
  loadGroups: (...args: unknown[]) => mockLoadGroups(...(args as [])),
  saveGroups: (...args: unknown[]) => mockSaveGroups(...args),
  loadGroupAssignments: (...args: unknown[]) => mockLoadGroupAssignments(...(args as [])),
  saveGroupAssignments: (...args: unknown[]) => mockSaveGroupAssignments(...args),
  loadCollapsedGroups: (...args: unknown[]) => mockLoadCollapsedGroups(...(args as [])),
  saveCollapsedGroups: (...args: unknown[]) => mockSaveCollapsedGroups(...args),
  loadGroupColors: (...args: unknown[]) => mockLoadGroupColors(...(args as [])),
  saveGroupColors: (...args: unknown[]) => mockSaveGroupColors(...args),
  windowKey: (w: EditorWindow) => mockWindowKey(w),
  sortWindowsByOrder: (windows: EditorWindow[], order: string[]) => mockSortWindowsByOrder(windows, order),
}));

function makeWindow(overrides: Partial<EditorWindow> = {}): EditorWindow {
  return {
    id: 1,
    name: "my-project",
    path: "/Users/test/my-project",
    bundle_id: "com.microsoft.VSCode",
    editor_name: "VSCode",
    ...overrides,
  };
}

type ListenHandler = (event: { payload: unknown }) => void;

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
    mockSaveTabOrder.mockClear().mockResolvedValue(undefined);
    mockSaveTabColors.mockClear().mockResolvedValue(undefined);
    mockLoadGroups.mockClear().mockResolvedValue([]);
    mockSaveGroups.mockClear().mockResolvedValue(undefined);
    mockLoadGroupAssignments.mockClear().mockResolvedValue({});
    mockSaveGroupAssignments.mockClear().mockResolvedValue(undefined);
    mockLoadCollapsedGroups.mockClear().mockResolvedValue([]);
    mockSaveCollapsedGroups.mockClear().mockResolvedValue(undefined);
    mockLoadGroupColors.mockClear().mockResolvedValue({});
    mockSaveGroupColors.mockClear().mockResolvedValue(undefined);
    mockSortWindowsByOrder.mockClear().mockImplementation((windows) => [...windows]);
  });

  it("starts with empty windows and activeIndex 0", () => {
    const { result } = setup();
    expect(result.current.windows).toEqual([]);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.tabColors).toEqual({});
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
      expect(invoke).toHaveBeenCalledWith("get_all_editor_windows");
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

      expect(invoke).toHaveBeenCalledWith("get_all_editor_windows");
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
      const { result } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      vi.mocked(invoke).mockResolvedValue([reopened]);
      await act(async () => {
        await result.current.refreshWindows();
      });

      expect(result.current.windows[0].id).toBe(2);
    });
  });

  describe("syncActiveTab", () => {
    it("syncs active tab with frontmost window", async () => {
      const win1 = makeWindow({ id: 1, name: "alpha" });
      const win2 = makeWindow({ id: 2, name: "beta" });

      // Setup: first fetch windows
      vi.mocked(invoke).mockResolvedValue([win1, win2]);
      const { result, params } = setup();

      await act(async () => {
        await result.current.refreshWindows();
      });

      // Mock get_editor_state to return beta as active
      const editorState: EditorState = {
        is_active: true,
        windows: [win1, win2],
        active_index: 1,
      };
      vi.mocked(invoke).mockResolvedValue(editorState);

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
      const editorState: EditorState = {
        is_active: true,
        windows: [win1, win2],
        active_index: 0,
      };
      vi.mocked(invoke).mockResolvedValue(editorState);

      await act(async () => {
        await result.current.syncActiveTab();
      });

      // Active index should NOT have changed back to 0
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
      expect(params.dismissWaitingForWindow).toHaveBeenCalledWith(win2);
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

    it("cleans up listeners on unmount", async () => {
      const { unmount, listeners } = setup();

      await waitFor(() => expect(listeners.size).toBeGreaterThan(0));

      unmount();
      expect(listeners.size).toBe(0);
    });
  });
});
