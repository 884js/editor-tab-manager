import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorWindow, HistoryEntry } from "../types/editor";
import { MAX_HISTORY_ENTRIES } from "../types/editor";
import { useHistory } from "./useHistory";

// Mock store functions directly (store.ts is tested separately)
const mockLoadHistory = vi.fn<() => Promise<HistoryEntry[]>>().mockResolvedValue([]);
const mockSaveHistory = vi.fn<(entries: HistoryEntry[]) => Promise<void>>().mockResolvedValue(undefined);

vi.mock("../utils/store", () => ({
  loadHistory: (...args: unknown[]) => mockLoadHistory(...(args as [])),
  saveHistory: (...args: unknown[]) => mockSaveHistory(...(args as [HistoryEntry[]])),
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

function setup(historyEntries: HistoryEntry[] = []) {
  mockLoadHistory.mockResolvedValue(historyEntries);

  const refreshWindowsRef = { current: vi.fn().mockResolvedValue(undefined) };

  const { result, rerender, unmount } = renderHook(() =>
    useHistory({ refreshWindowsRef })
  );

  return { result, rerender, unmount, refreshWindowsRef };
}

describe("useHistory", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    mockLoadHistory.mockClear();
    mockSaveHistory.mockClear();
  });

  it("loads history from Store on mount", async () => {
    const entries: HistoryEntry[] = [
      { name: "proj", path: "/path/proj", bundleId: "com.microsoft.VSCode", editorName: "VSCode", timestamp: 1000 },
    ];
    const { result } = setup(entries);

    await waitFor(() => {
      expect(result.current.history).toEqual(entries);
    });
    expect(mockLoadHistory).toHaveBeenCalledOnce();
  });

  it("starts with empty history when store is empty", async () => {
    const { result } = setup();

    await waitFor(() => {
      expect(result.current.history).toEqual([]);
    });
  });

  describe("addToHistory", () => {
    it("adds disappeared windows to history", async () => {
      const { result } = setup();

      await waitFor(() => {
        expect(result.current.history).toEqual([]);
      });

      const win = makeWindow({ name: "project-a", path: "/path/a" });
      act(() => {
        result.current.addToHistory([win]);
      });

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0].name).toBe("project-a");
      expect(result.current.history[0].path).toBe("/path/a");
      expect(result.current.history[0].bundleId).toBe("com.microsoft.VSCode");
    });

    it("skips windows without path", async () => {
      const { result } = setup();

      await waitFor(() => {
        expect(result.current.history).toEqual([]);
      });

      const win = makeWindow({ name: "nopath", path: "" });
      act(() => {
        result.current.addToHistory([win]);
      });

      expect(result.current.history).toHaveLength(0);
    });

    it("deduplicates by name+bundleId", async () => {
      const existing: HistoryEntry[] = [
        { name: "proj", path: "/old", bundleId: "com.microsoft.VSCode", editorName: "VSCode", timestamp: 1000 },
      ];
      const { result } = setup(existing);

      await waitFor(() => {
        expect(result.current.history).toHaveLength(1);
      });

      const win = makeWindow({ name: "proj", path: "/new" });
      act(() => {
        result.current.addToHistory([win]);
      });

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0].path).toBe("/new");
    });

    it("respects MAX_HISTORY_ENTRIES limit", async () => {
      const entries: HistoryEntry[] = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => ({
        name: `proj-${i}`,
        path: `/path/${i}`,
        bundleId: "com.microsoft.VSCode",
        editorName: "VSCode",
        timestamp: 1000 + i,
      }));
      const { result } = setup(entries);

      await waitFor(() => {
        expect(result.current.history).toHaveLength(MAX_HISTORY_ENTRIES);
      });

      const win = makeWindow({ name: "new-proj", path: "/path/new" });
      act(() => {
        result.current.addToHistory([win]);
      });

      expect(result.current.history).toHaveLength(MAX_HISTORY_ENTRIES);
      expect(result.current.history[0].name).toBe("new-proj");
    });

    it("saves to Store after adding", async () => {
      const { result } = setup();

      await waitFor(() => {
        expect(result.current.history).toEqual([]);
      });

      const win = makeWindow({ name: "proj", path: "/path" });
      act(() => {
        result.current.addToHistory([win]);
      });

      expect(mockSaveHistory).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: "proj" })])
      );
    });
  });

  describe("handleOpenFromHistory", () => {
    it("invokes open_project_in_editor and refreshes windows", async () => {
      vi.useFakeTimers();
      vi.mocked(invoke).mockResolvedValue(undefined);

      const entry: HistoryEntry = {
        name: "proj",
        path: "/path/proj",
        bundleId: "com.microsoft.VSCode",
        editorName: "VSCode",
        timestamp: 1000,
      };
      const { result, refreshWindowsRef } = setup([entry]);

      await vi.waitFor(() => {
        expect(result.current.history).toHaveLength(1);
      });

      await act(async () => {
        await result.current.handleOpenFromHistory(entry);
      });

      expect(invoke).toHaveBeenCalledWith("open_project_in_editor", {
        bundle_id: "com.microsoft.VSCode",
        path: "/path/proj",
      });

      // After 1500ms, refreshWindows should be called
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(refreshWindowsRef.current).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("handleClearHistory", () => {
    it("clears history and saves empty array to Store", async () => {
      const entries: HistoryEntry[] = [
        { name: "proj", path: "/path", bundleId: "com.microsoft.VSCode", editorName: "VSCode", timestamp: 1000 },
      ];
      const { result } = setup(entries);

      await vi.waitFor(() => {
        expect(result.current.history).toHaveLength(1);
      });

      act(() => {
        result.current.handleClearHistory();
      });

      expect(result.current.history).toEqual([]);
      expect(mockSaveHistory).toHaveBeenCalledWith([]);
    });
  });

  describe("showAddMenu state", () => {
    it("defaults to false", () => {
      const { result } = setup();
      expect(result.current.showAddMenu).toBe(false);
    });

    it("can be toggled via setShowAddMenu", () => {
      const { result } = setup();

      act(() => {
        result.current.setShowAddMenu(true);
      });
      expect(result.current.showAddMenu).toBe(true);

      act(() => {
        result.current.setShowAddMenu(false);
      });
      expect(result.current.showAddMenu).toBe(false);
    });
  });
});
