import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { EditorWindow, ClaudeStatusPayload } from "../types/editor";
import { useClaudeStatus } from "./useClaudeStatus";

type ListenHandler = (event: { payload: ClaudeStatusPayload }) => void;

function makeRefs() {
  return {
    windowsRef: { current: [] as EditorWindow[] },
    activeIndexRef: { current: 0 },
    isEditorActiveRef: { current: true },
    isVisibleRef: { current: true },
    notificationEnabledRef: { current: true },
  };
}

function setup(refs = makeRefs()) {
  // Capture listen callbacks by event name
  const listeners = new Map<string, ListenHandler>();
  vi.mocked(listen).mockImplementation(async (event: string, handler: unknown) => {
    listeners.set(event, handler as ListenHandler);
    return () => {
      listeners.delete(event);
    };
  });

  const { result, unmount } = renderHook(() => useClaudeStatus(refs));

  const emitClaudeStatus = (payload: ClaudeStatusPayload) => {
    const handler = listeners.get("claude-status");
    if (handler) handler({ payload });
  };

  return { result, unmount, refs, emitClaudeStatus, listeners };
}

describe("useClaudeStatus", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockClear();
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    vi.mocked(requestPermission).mockResolvedValue("granted");
  });

  it("initializes notification permission", async () => {
    setup();
    await waitFor(() => {
      expect(isPermissionGranted).toHaveBeenCalled();
    });
  });

  it("requests permission when not granted", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    setup();
    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalled();
    });
  });

  it("starts with empty statuses", () => {
    const { result } = setup();
    expect(result.current.claudeStatuses).toEqual({});
  });

  describe("claude-status event", () => {
    it("updates statuses on event", async () => {
      const { result, emitClaudeStatus } = setup();

      await waitFor(() => expect(listen).toHaveBeenCalled());

      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "generating" } });
      });

      expect(result.current.claudeStatuses).toEqual({ "/path/proj": "generating" });
    });

    it("sends notification on generating → waiting transition", async () => {
      const refs = makeRefs();
      refs.isEditorActiveRef.current = false; // not in editor — show notification
      const { emitClaudeStatus } = setup(refs);

      await waitFor(() => expect(listen).toHaveBeenCalled());

      // First: generating
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "generating" } });
      });

      // Then: waiting (= completed)
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      expect(invoke).toHaveBeenCalledWith("send_notification", expect.objectContaining({
        project_path: "/path/proj",
      }));
    });

    it("does NOT send notification when editor is active", async () => {
      const refs = makeRefs();
      refs.isEditorActiveRef.current = true;
      const { emitClaudeStatus } = setup(refs);

      await waitFor(() => expect(listen).toHaveBeenCalled());

      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "generating" } });
      });
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      expect(invoke).not.toHaveBeenCalledWith("send_notification", expect.anything());
    });

    it("does NOT send notification when notifications disabled", async () => {
      const refs = makeRefs();
      refs.isEditorActiveRef.current = false;
      refs.notificationEnabledRef.current = false;
      const { emitClaudeStatus } = setup(refs);

      await waitFor(() => expect(listen).toHaveBeenCalled());

      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "generating" } });
      });
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      expect(invoke).not.toHaveBeenCalledWith("send_notification", expect.anything());
    });

    it("performs reset animation on waiting → generating transition (150ms delay)", async () => {
      vi.useFakeTimers();
      const { result, emitClaudeStatus } = setup();

      await vi.waitFor(() => expect(listen).toHaveBeenCalled());

      // Start as waiting
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      // Transition to generating (reset animation)
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "generating" } });
      });

      // During animation: the path should be temporarily removed
      expect(result.current.claudeStatuses["/path/proj"]).toBeUndefined();

      // After 150ms: restored
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(result.current.claudeStatuses["/path/proj"]).toBe("generating");

      vi.useRealTimers();
    });
  });

  describe("dismissWaitingForWindow", () => {
    it("dismisses waiting badge for a window", async () => {
      const refs = makeRefs();
      refs.windowsRef.current = [
        { id: 1, name: "proj", path: "/path/proj", bundle_id: "com.microsoft.VSCode", editor_name: "VSCode" },
      ];
      const { result, emitClaudeStatus } = setup(refs);

      await waitFor(() => expect(listen).toHaveBeenCalled());

      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      expect(result.current.claudeStatuses["/path/proj"]).toBe("waiting");

      act(() => {
        result.current.dismissWaitingForWindow(refs.windowsRef.current[0]);
      });

      // The waiting status should be removed from claudeStatuses
      expect(result.current.claudeStatuses["/path/proj"]).toBeUndefined();
    });

    it("adds path to dismissed set", async () => {
      const refs = makeRefs();
      refs.windowsRef.current = [
        { id: 1, name: "proj", path: "/path/proj", bundle_id: "com.microsoft.VSCode", editor_name: "VSCode" },
      ];
      const { result, emitClaudeStatus } = setup(refs);

      await waitFor(() => expect(listen).toHaveBeenCalled());

      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      act(() => {
        result.current.dismissWaitingForWindow(refs.windowsRef.current[0]);
      });

      expect(result.current.dismissedWaitingRef.current.has("/path/proj")).toBe(true);
    });

    it("clears dismissed path when generating again", async () => {
      const refs = makeRefs();
      refs.windowsRef.current = [
        { id: 1, name: "proj", path: "/path/proj", bundle_id: "com.microsoft.VSCode", editor_name: "VSCode" },
      ];
      const { result, emitClaudeStatus } = setup(refs);

      await waitFor(() => expect(listen).toHaveBeenCalled());

      // waiting → dismiss
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });
      act(() => {
        result.current.dismissWaitingForWindow(refs.windowsRef.current[0]);
      });

      expect(result.current.dismissedWaitingRef.current.has("/path/proj")).toBe(true);

      // New event: generating → should clear dismissed
      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "generating" } });
      });

      expect(result.current.dismissedWaitingRef.current.has("/path/proj")).toBe(false);
    });
  });

  describe("syncWaitingTimer", () => {
    it("auto-dismisses active tab waiting badge after 15s", async () => {
      vi.useFakeTimers();

      const refs = makeRefs();
      refs.windowsRef.current = [
        { id: 1, name: "proj", path: "/path/proj", bundle_id: "com.microsoft.VSCode", editor_name: "VSCode" },
      ];
      refs.activeIndexRef.current = 0;
      const { result, emitClaudeStatus } = setup(refs);

      await vi.waitFor(() => expect(listen).toHaveBeenCalled());

      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      expect(result.current.claudeStatuses["/path/proj"]).toBe("waiting");

      // Advance 15 seconds
      act(() => {
        vi.advanceTimersByTime(15_000);
      });

      expect(result.current.claudeStatuses["/path/proj"]).toBeUndefined();
      expect(result.current.dismissedWaitingRef.current.has("/path/proj")).toBe(true);

      vi.useRealTimers();
    });

    it("clears existing timers when called again", async () => {
      vi.useFakeTimers();

      const refs = makeRefs();
      refs.windowsRef.current = [
        { id: 1, name: "proj", path: "/path/proj", bundle_id: "com.microsoft.VSCode", editor_name: "VSCode" },
      ];
      refs.activeIndexRef.current = 0;
      const { result, emitClaudeStatus } = setup(refs);

      await vi.waitFor(() => expect(listen).toHaveBeenCalled());

      act(() => {
        emitClaudeStatus({ statuses: { "/path/proj": "waiting" } });
      });

      // Call syncWaitingTimer again (resets the timer)
      act(() => {
        result.current.syncWaitingTimer();
      });

      // Old timer should be cleared, new one started
      // After 14 seconds, still visible
      act(() => {
        vi.advanceTimersByTime(14_000);
      });
      expect(result.current.claudeStatuses["/path/proj"]).toBe("waiting");

      // After 1 more second (15s total from reset), auto-dismissed
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(result.current.claudeStatuses["/path/proj"]).toBeUndefined();

      vi.useRealTimers();
    });
  });

  it("cleans up listeners on unmount", async () => {
    const { unmount, listeners } = setup();

    await waitFor(() => expect(listen).toHaveBeenCalled());

    unmount();

    // Listeners should be cleaned up (our mock removes them)
    expect(listeners.size).toBe(0);
  });
});
