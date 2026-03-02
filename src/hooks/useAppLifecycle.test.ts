import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { isEnabled } from "@tauri-apps/plugin-autostart";
import { createMockStore } from "../test/setup";
import type { AppActivationPayload } from "../types/editor";
import { useAppLifecycle } from "./useAppLifecycle";

// Mock getStore to avoid module-level caching
let activeMockStore: ReturnType<typeof createMockStore>;
vi.mock("../utils/store", () => ({
  getStore: () => Promise.resolve(activeMockStore),
}));

type ListenHandler = (event: { payload: unknown }) => void;

function makeParams() {
  return {
    fetchWindowsRef: { current: vi.fn().mockResolvedValue(1) },
    syncActiveTabRef: { current: vi.fn().mockResolvedValue(undefined) },
    showAddMenuRef: { current: false },
    setShowAddMenu: vi.fn(),
    isVisibleRef: { current: false },
    isEditorActiveRef: { current: false },
    isTabManagerActiveRef: { current: false },
    currentBundleIdRef: { current: null as string | null },
    notificationEnabledRef: { current: true },
  };
}

function setup(storeData: Record<string, unknown> = {}) {
  activeMockStore = createMockStore(storeData);

  const listeners = new Map<string, ListenHandler>();
  vi.mocked(listen).mockImplementation(async (event: string, handler: unknown) => {
    listeners.set(event, handler as ListenHandler);
    return () => {
      listeners.delete(event);
    };
  });

  const params = makeParams();
  const { result, unmount } = renderHook(() => useAppLifecycle(params));

  return { result, unmount, params, listeners, mockStore: activeMockStore };
}

describe("useAppLifecycle", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(true); // default: accessibility permission granted
    vi.mocked(listen).mockClear();
    vi.mocked(isEnabled).mockResolvedValue(false);
  });

  describe("accessibility permission", () => {
    it("checks permission on mount", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result } = setup();

      await waitFor(() => {
        expect(result.current.hasAccessibilityPermission).toBe(true);
      });
      expect(invoke).toHaveBeenCalledWith("check_accessibility_permission");
    });

    it("handles permission denied", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "check_accessibility_permission") return false;
        return undefined;
      });
      const { result } = setup();

      await waitFor(() => {
        expect(result.current.hasAccessibilityPermission).toBe(false);
      });
    });

    it("handlePermissionGranted updates state", async () => {
      vi.mocked(invoke).mockResolvedValue(false);
      const { result } = setup();

      await waitFor(() => {
        expect(result.current.hasAccessibilityPermission).toBe(false);
      });

      act(() => {
        result.current.handlePermissionGranted();
      });

      expect(result.current.hasAccessibilityPermission).toBe(true);
    });
  });

  describe("onboarding", () => {
    it("shows onboarding for new users (no store data)", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result } = setup();

      await waitFor(() => {
        expect(result.current.onboardingCompleted).toBe(false);
      });
    });

    it("skips onboarding when completed flag is set", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result } = setup({ "onboarding:completed": true });

      await waitFor(() => {
        expect(result.current.onboardingCompleted).toBe(true);
      });
    });

    it("skips onboarding for existing users with order keys", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result } = setup({ "order:unified": ["key1"] });

      await waitFor(() => {
        expect(result.current.onboardingCompleted).toBe(true);
      });
    });

    it("handleOnboardingComplete saves to store when dontShowAgain", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result, mockStore } = setup();

      await waitFor(() => {
        expect(result.current.onboardingCompleted).toBe(false);
      });

      await act(async () => {
        await result.current.handleOnboardingComplete(true);
      });

      expect(result.current.onboardingCompleted).toBe(true);
      expect(mockStore.set).toHaveBeenCalledWith("onboarding:completed", true);
    });
  });

  describe("store migration", () => {
    it("migrates per-editor order keys to unified key", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { mockStore } = setup({
        "order:com.microsoft.VSCode": ["proj1", "proj2"],
        "order:dev.zed.Zed": ["proj3"],
      });

      await waitFor(() => {
        expect(mockStore.set).toHaveBeenCalledWith(
          "order:unified",
          expect.arrayContaining([
            "com.microsoft.VSCode:proj1",
            "com.microsoft.VSCode:proj2",
            "dev.zed.Zed:proj3",
          ])
        );
      });
    });

    it("migrates per-editor color keys to unified key", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { mockStore } = setup({
        "tabColor:com.microsoft.VSCode": { proj1: "red" },
        "tabColor:dev.zed.Zed": { proj2: "blue" },
      });

      await waitFor(() => {
        expect(mockStore.set).toHaveBeenCalledWith(
          "tabColor:unified",
          expect.objectContaining({ proj1: "red", proj2: "blue" })
        );
      });
    });

    it("skips migration when unified key already exists", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { mockStore } = setup({
        "order:unified": ["existing"],
        "order:com.microsoft.VSCode": ["old"],
      });

      await waitFor(() => {
        expect(mockStore.get).toHaveBeenCalledWith("order:unified");
      });

      // The old key should NOT be migrated since unified already exists
      const setCalls = mockStore.set.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "order:unified" &&
          Array.isArray(call[1]) &&
          (call[1] as string[]).includes("com.microsoft.VSCode:old")
      );
      expect(setCalls).toHaveLength(0);
    });
  });

  describe("settings from store", () => {
    it("loads showBranch setting from store", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result } = setup({ "settings:showBranch": false });

      await waitFor(() => {
        expect(result.current.showBranch).toBe(false);
      });
    });
  });

  describe("window resizing", () => {
    it("resizeTabBar sets window to primary monitor width", async () => {
      const appWindow = getCurrentWindow();
      vi.mocked(invoke).mockResolvedValue(true);
      const { result } = setup();

      await act(async () => {
        await result.current.resizeTabBar();
      });

      expect(primaryMonitor).toHaveBeenCalled();
      expect(appWindow.setSize).toHaveBeenCalled();
      expect(appWindow.setPosition).toHaveBeenCalled();
    });

  });

  describe("app-activated event", () => {
    it("shows window and fetches windows on editor activation", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result, listeners, params } = setup({ "onboarding:completed": true });

      await waitFor(() => {
        expect(result.current.hasAccessibilityPermission).toBe(true);
        expect(result.current.onboardingCompleted).toBe(true);
      });

      await waitFor(() => {
        expect(listeners.has("app-activated")).toBe(true);
      });

      const appWindow = getCurrentWindow();
      vi.mocked(invoke).mockResolvedValue(undefined);

      await act(async () => {
        const handler = listeners.get("app-activated")!;
        handler({
          payload: {
            app_type: "editor",
            bundle_id: "com.microsoft.VSCode",
            is_on_primary_screen: true,
            is_large_window: false,
          } satisfies AppActivationPayload,
        });
      });

      expect(params.isEditorActiveRef.current).toBe(true);
      expect(params.currentBundleIdRef.current).toBe("com.microsoft.VSCode");
      expect(appWindow.show).toHaveBeenCalled();
    });

    it("hides window on other app activation", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result, listeners, params } = setup({ "onboarding:completed": true });

      await waitFor(() => {
        expect(result.current.hasAccessibilityPermission).toBe(true);
        expect(result.current.onboardingCompleted).toBe(true);
      });

      await waitFor(() => {
        expect(listeners.has("app-activated")).toBe(true);
      });

      params.isVisibleRef.current = true;

      const appWindow = getCurrentWindow();
      vi.mocked(invoke).mockResolvedValue(undefined);

      await act(async () => {
        const handler = listeners.get("app-activated")!;
        handler({
          payload: {
            app_type: "other",
            bundle_id: "com.apple.Safari",
            is_on_primary_screen: true,
            is_large_window: true,
          } satisfies AppActivationPayload,
        });
      });

      expect(params.isEditorActiveRef.current).toBe(false);
      expect(appWindow.setPosition).toHaveBeenCalled();
    });

    it("keeps tab bar visible for small window apps", async () => {
      vi.mocked(invoke).mockResolvedValue(true);
      const { result, listeners, params } = setup({ "onboarding:completed": true });

      await waitFor(() => {
        expect(result.current.hasAccessibilityPermission).toBe(true);
        expect(result.current.onboardingCompleted).toBe(true);
      });

      await waitFor(() => {
        expect(listeners.has("app-activated")).toBe(true);
      });

      params.isVisibleRef.current = true;

      const appWindow = getCurrentWindow();
      vi.mocked(appWindow.setPosition).mockClear();
      vi.mocked(invoke).mockResolvedValue(undefined);

      await act(async () => {
        const handler = listeners.get("app-activated")!;
        handler({
          payload: {
            app_type: "other",
            bundle_id: "com.apple.systempreferences",
            is_on_primary_screen: true,
            is_large_window: false,
          } satisfies AppActivationPayload,
        });
      });

      expect(params.isEditorActiveRef.current).toBe(false);
      expect(params.isVisibleRef.current).toBe(true);
      expect(appWindow.setPosition).not.toHaveBeenCalled();
    });
  });
});
