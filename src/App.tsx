import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { currentMonitor } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import type { Store } from "@tauri-apps/plugin-store";
import TabBar from "./components/TabBar";
import Settings from "./components/Settings";
import AccessibilityGuide from "./components/AccessibilityGuide";

// タブバーの高さ（px）
const TAB_BAR_HEIGHT = 36;

export interface EditorWindow {
  id: number;
  name: string;
  path: string;
}

interface EditorState {
  is_active: boolean;
  windows: EditorWindow[];
  active_index: number | null;  // Index of the frontmost window
}

// Store instance (lazily initialized)
let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load("tab-order.json");
  }
  return storePromise;
}

// Get order key based on editor bundle ID
function getOrderKey(bundleId: string | null): string {
  return `order:${bundleId || "default"}`;
}

// Load tab order from Store
async function loadTabOrder(bundleId: string | null): Promise<string[]> {
  try {
    const store = await getStore();
    const key = getOrderKey(bundleId);
    const saved = await store.get<string[]>(key);
    return saved || [];
  } catch {
    return [];
  }
}

// Save tab order to Store
async function saveTabOrder(bundleId: string | null, order: string[]): Promise<void> {
  try {
    const store = await getStore();
    const key = getOrderKey(bundleId);
    await store.set(key, order);
  } catch (error) {
    console.error("Failed to save tab order:", error);
  }
}

// Sort windows by custom order, new windows go to the end
function sortWindowsByOrder(windows: EditorWindow[], order: string[]): EditorWindow[] {
  const orderMap = new Map(order.map((name, index) => [name, index]));
  return [...windows].sort((a, b) => {
    const indexA = orderMap.get(a.name) ?? Infinity;
    const indexB = orderMap.get(b.name) ?? Infinity;
    if (indexA === Infinity && indexB === Infinity) {
      // Both are new, sort alphabetically
      return a.name.localeCompare(b.name);
    }
    return indexA - indexB;
  });
}

// Payload from app-activated event
interface AppActivationPayload {
  app_type: "editor" | "tab_manager" | "other";
  bundle_id: string | null;
}

// Claude Code の状態
export type ClaudeStatus = "waiting" | "generating";

// Payload from claude-status event
interface ClaudeStatusPayload {
  statuses: Record<string, ClaudeStatus>;
}

function App() {
  const [windows, setWindows] = useState<EditorWindow[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [claudeStatuses, setClaudeStatuses] = useState<Record<string, ClaudeStatus>>({});
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [hasAccessibilityPermission, setHasAccessibilityPermission] = useState<boolean | null>(null);
  const windowsRef = useRef<EditorWindow[]>([]);
  const activeIndexRef = useRef<number>(0);
  const isVisibleRef = useRef(true);
  const isInitializedRef = useRef(false);
  const tabOrderRef = useRef<string[]>([]);
  const isEditorActiveRef = useRef(false); // Track if editor (VSCode/Cursor) is currently active
  const isTabManagerActiveRef = useRef(false); // Track if tab_manager itself is currently active
  const currentBundleIdRef = useRef<string | null>(null); // Current editor's bundle ID
  const orderLoadedRef = useRef(false); // Track if order has been loaded from store
  const lastTabClickTimeRef = useRef<number>(0); // Track when tab was last clicked (for debounce)

  // Check accessibility permission on startup
  useEffect(() => {
    const checkPermission = async () => {
      try {
        const hasPermission = await invoke<boolean>("check_accessibility_permission");
        setHasAccessibilityPermission(hasPermission);
      } catch (error) {
        console.error("Failed to check accessibility permission:", error);
        // Default to true to avoid blocking the app on error
        setHasAccessibilityPermission(true);
      }
    };
    checkPermission();
  }, []);

  const handlePermissionGranted = useCallback(() => {
    setHasAccessibilityPermission(true);
  }, []);

  // Adjust window size based on accessibility permission state
  useEffect(() => {
    if (hasAccessibilityPermission === null) return;

    const adjustWindowSize = async () => {
      const appWindow = getCurrentWindow();
      const monitor = await currentMonitor();
      if (!monitor) return;

      const screenWidth = monitor.size.width / monitor.scaleFactor;
      const screenHeight = monitor.size.height / monitor.scaleFactor;

      if (!hasAccessibilityPermission) {
        // AccessibilityGuide用: 大きいウィンドウ（設定画面と同様）
        await appWindow.setMaxSize(new LogicalSize(screenWidth, screenHeight));
        await appWindow.setSize(new LogicalSize(600, 400));
        await appWindow.setPosition(new LogicalPosition(
          (screenWidth - 600) / 2,
          (screenHeight - 400) / 2
        ));
      } else {
        // 権限許可後: タブバーサイズに戻す
        await appWindow.setMaxSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
        await appWindow.setSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
        await appWindow.setPosition(new LogicalPosition(0, 0));
      }
    };

    adjustWindowSize();
  }, [hasAccessibilityPermission]);

  // Keep refs in sync with state
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const refreshWindows = useCallback(async () => {
    try {
      const bundleId = currentBundleIdRef.current;

      // Load order from store if not already loaded
      if (!orderLoadedRef.current) {
        tabOrderRef.current = await loadTabOrder(bundleId);
        orderLoadedRef.current = true;
      }

      const result = await invoke<EditorWindow[]>("get_editor_windows", { bundle_id: bundleId });
      // Sort by custom order
      const sorted = sortWindowsByOrder(result, tabOrderRef.current);
      // Update order with current windows (remove deleted, keep order for existing)
      // Only save if order actually changed to avoid unnecessary writes
      const newOrder = sorted.map(w => w.name);
      const orderChanged = newOrder.length !== tabOrderRef.current.length ||
        newOrder.some((name, i) => tabOrderRef.current[i] !== name);
      if (orderChanged) {
        tabOrderRef.current = newOrder;
        // Don't save here - only save on explicit reorder
      }

      // Only update state if windows actually changed (prevents unnecessary re-renders)
      const currentWindows = windowsRef.current;
      const hasChanged = sorted.length !== currentWindows.length ||
        sorted.some((w, i) => currentWindows[i]?.name !== w.name);

      if (hasChanged) {
        setWindows(sorted);
        if (sorted.length > 0 && activeIndexRef.current >= sorted.length) {
          setActiveIndex(sorted.length - 1);
        }
      }
    } catch (error) {
      console.error("Failed to get editor windows:", error);
    }
  }, []);

  // Sync active tab with frontmost editor window (called on window-focus-changed event)
  const syncActiveTab = useCallback(async () => {
    // タブクリック直後（200ms以内）は同期をスキップ（競合状態を防ぐ）
    const timeSinceLastClick = Date.now() - lastTabClickTimeRef.current;
    if (timeSinceLastClick < 200) {
      return;
    }

    try {
      const bundleId = currentBundleIdRef.current;
      const state = await invoke<EditorState>("get_editor_state", { bundle_id: bundleId });

      // Sync activeIndex with frontmost editor window
      if (state.active_index !== null && state.windows.length > 0) {
        const sorted = sortWindowsByOrder(state.windows, tabOrderRef.current);
        const frontmostName = state.windows[state.active_index]?.name;
        const sortedIndex = sorted.findIndex(w => w.name === frontmostName);
        if (sortedIndex >= 0 && sortedIndex !== activeIndexRef.current) {
          setActiveIndex(sortedIndex);
        }
      }
    } catch (error) {
      console.error("Failed to sync active tab:", error);
    }
  }, []);


  const handleTabClick = useCallback((index: number) => {
    // 同じタブなら何もしない
    if (index === activeIndexRef.current) return;

    // クリック時刻を記録（syncActiveTabのデバウンス用）
    lastTabClickTimeRef.current = Date.now();
    setActiveIndex(index);
    const window = windowsRef.current[index];
    if (window) {
      const bundleId = currentBundleIdRef.current;
      if (!bundleId) {
        console.warn("No bundle_id available, cannot focus window");
        return;
      }
      // Fire-and-forget: don't await, let UI respond immediately
      // Use window.id (CGWindowID) for reliable window identification
      invoke("focus_editor_window", { bundle_id: bundleId, window_id: window.id }).catch((error) => {
        console.error("Failed to focus window:", error);
      });
    }
  }, []);

  const handleNewTab = useCallback(async () => {
    try {
      const bundleId = currentBundleIdRef.current;
      if (!bundleId) {
        console.warn("No bundle_id available, cannot open new editor window");
        return;
      }
      await invoke("open_new_editor", { bundle_id: bundleId });
      setTimeout(refreshWindows, 1000);
    } catch (error) {
      console.error("Failed to open new editor:", error);
    }
  }, [refreshWindows]);

  const handleCloseTab = useCallback(async (index: number) => {
    const window = windowsRef.current[index];
    if (window) {
      try {
        const bundleId = currentBundleIdRef.current;
        if (!bundleId) {
          console.warn("No bundle_id available, cannot close window");
          return;
        }
        await invoke("close_editor_window", { bundle_id: bundleId, window_id: window.id });
        setTimeout(refreshWindows, 500);
      } catch (error) {
        console.error("Failed to close window:", error);
      }
    }
  }, [refreshWindows]);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const currentWindows = windowsRef.current;
    if (fromIndex < 0 || fromIndex >= currentWindows.length ||
        toIndex < 0 || toIndex >= currentWindows.length) {
      return;
    }

    // Create new array with reordered windows
    const newWindows = [...currentWindows];
    const [moved] = newWindows.splice(fromIndex, 1);
    newWindows.splice(toIndex, 0, moved);

    // Update order and save to Store (only on explicit reorder)
    const newOrder = newWindows.map(w => w.name);
    tabOrderRef.current = newOrder;
    saveTabOrder(currentBundleIdRef.current, newOrder);

    // Update activeIndex if needed
    let newActiveIndex = activeIndexRef.current;
    if (fromIndex === activeIndexRef.current) {
      // Moved the active tab
      newActiveIndex = toIndex;
    } else if (fromIndex < activeIndexRef.current && toIndex >= activeIndexRef.current) {
      // Moved a tab from before active to after
      newActiveIndex = activeIndexRef.current - 1;
    } else if (fromIndex > activeIndexRef.current && toIndex <= activeIndexRef.current) {
      // Moved a tab from after active to before
      newActiveIndex = activeIndexRef.current + 1;
    }

    setWindows(newWindows);
    setActiveIndex(newActiveIndex);
  }, []);

  // Refs for callback functions to avoid stale closures in event listeners
  const refreshWindowsRef = useRef(refreshWindows);
  const handleCloseTabRef = useRef(handleCloseTab);
  const handleTabClickRef = useRef(handleTabClick);
  const handleNewTabRef = useRef(handleNewTab);
  const syncActiveTabRef = useRef(syncActiveTab);

  useEffect(() => {
    refreshWindowsRef.current = refreshWindows;
  }, [refreshWindows]);

  useEffect(() => {
    handleCloseTabRef.current = handleCloseTab;
  }, [handleCloseTab]);

  useEffect(() => {
    handleTabClickRef.current = handleTabClick;
  }, [handleTabClick]);

  useEffect(() => {
    handleNewTabRef.current = handleNewTab;
  }, [handleNewTab]);

  useEffect(() => {
    syncActiveTabRef.current = syncActiveTab;
  }, [syncActiveTab]);

  // Setup event listeners - only once on mount
  useEffect(() => {
    let isMounted = true;
    const cleanupFns: (() => void)[] = [];

    const setupListeners = async () => {
      const unlistenRefresh = await listen("refresh-windows", () => {
        if (isMounted) {
          setTimeout(() => {
            refreshWindowsRef.current();
          }, 1000);
        }
      });
      cleanupFns.push(unlistenRefresh);

      // Listen for open-new-editor-tab event (from Cmd+Shift+T shortcut)
      const unlistenNewTab = await listen("open-new-editor-tab", () => {
        if (isMounted) {
          handleNewTabRef.current();
        }
      });
      cleanupFns.push(unlistenNewTab);

      const unlistenClose = await listen("close-current-tab", () => {
        if (isMounted) {
          const currentIndex = activeIndexRef.current;
          const currentWindows = windowsRef.current;
          const bundleId = currentBundleIdRef.current;
          if (currentWindows[currentIndex] && bundleId) {
            invoke("close_editor_window", { bundle_id: bundleId, window_id: currentWindows[currentIndex].id });
            setTimeout(() => refreshWindowsRef.current(), 500);
          }
        }
      });
      cleanupFns.push(unlistenClose);

      const unlistenSwitch = await listen<number>("switch-to-tab", (event) => {
        if (isMounted && event.payload < windowsRef.current.length) {
          setActiveIndex(event.payload);
          const win = windowsRef.current[event.payload];
          const bundleId = currentBundleIdRef.current;
          if (win && bundleId) {
            invoke("focus_editor_window", { bundle_id: bundleId, window_id: win.id });
          }
        }
      });
      cleanupFns.push(unlistenSwitch);

      // Listen for window-focus-changed event from AXObserver (Rust backend)
      const unlistenWindowFocus = await listen("window-focus-changed", () => {
        if (isMounted) {
          syncActiveTabRef.current();
        }
      });
      cleanupFns.push(unlistenWindowFocus);

      // Listen for windows-changed event (window created/destroyed)
      const unlistenWindowsChanged = await listen("windows-changed", () => {
        if (isMounted) {
          refreshWindowsRef.current();
        }
      });
      cleanupFns.push(unlistenWindowsChanged);

      // Listen for Claude Code status events
      const unlistenClaude = await listen<ClaudeStatusPayload>("claude-status", (event) => {
        if (isMounted) {
          setClaudeStatuses(event.payload.statuses);
        }
      });
      cleanupFns.push(unlistenClaude);
    };

    setupListeners();

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
    };
  }, []); // Empty dependency array - listeners set up once

  // Fetch windows only (without visibility check) - used when editor is active
  const fetchWindows = useCallback(async (bundleId?: string | null) => {
    try {
      const targetBundleId = bundleId ?? currentBundleIdRef.current;

      // Load order from store if bundle changed or not loaded yet
      if (!orderLoadedRef.current || (bundleId && bundleId !== currentBundleIdRef.current)) {
        tabOrderRef.current = await loadTabOrder(targetBundleId);
        orderLoadedRef.current = true;
      }

      const result = await invoke<EditorWindow[]>("get_editor_windows", { bundle_id: targetBundleId });
      // Sort by custom order
      const sorted = sortWindowsByOrder(result, tabOrderRef.current);
      // Update order ref but don't save to store - only save on explicit reorder
      tabOrderRef.current = sorted.map(w => w.name);

      // Update windows only if changed
      const currentWindows = windowsRef.current;
      const hasChanged = sorted.length !== currentWindows.length ||
        sorted.some((w, i) => currentWindows[i]?.name !== w.name);

      if (hasChanged) {
        setWindows(sorted);
        if (sorted.length > 0 && activeIndexRef.current >= sorted.length) {
          setActiveIndex(sorted.length - 1);
        }
      }
    } catch (error) {
      console.error("Failed to fetch windows:", error);
    }
  }, []);

  // Event-driven visibility (no polling)
  useEffect(() => {
    // 権限が許可されるまでは何もしない（AccessibilityGuideが表示される）
    if (hasAccessibilityPermission !== true) {
      return;
    }

    const appWindow = getCurrentWindow();
    let isMounted = true;
    const cleanupFns: (() => void)[] = [];

    // Initialize window on startup - always start with tab bar
    const initWindow = async () => {
      const monitor = await currentMonitor();
      if (monitor) {
        const screenWidth = monitor.size.width / monitor.scaleFactor;
        await appWindow.setMaxSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
        await appWindow.setSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
        await appWindow.setPosition(new LogicalPosition(0, 0));
      }
      await appWindow.show();
      isVisibleRef.current = true;
      isInitializedRef.current = true;
      // 初期状態を同期
      await syncActiveTabRef.current();
    };
    initWindow();

    // Listen for app activation events from NSWorkspace observer
    const setupAppActivationListener = async () => {
      const unlisten = await listen<AppActivationPayload>("app-activated", async (event) => {
        if (!isMounted) return;

        const { app_type, bundle_id } = event.payload;

        if (app_type === "editor" || app_type === "tab_manager") {
          // Editor or our app is active - show the tab bar
          // Tab Manager active = user is operating the tab bar, so keep it visible
          isEditorActiveRef.current = app_type === "editor";
          isTabManagerActiveRef.current = app_type === "tab_manager";
          if (app_type === "editor" && bundle_id) {
            // Reload order from store if bundle changed
            if (bundle_id !== currentBundleIdRef.current) {
              orderLoadedRef.current = false;
            }
            // Update current bundle ID when editor becomes active
            currentBundleIdRef.current = bundle_id;
          }
          if (!isVisibleRef.current) {
            await appWindow.show();
            isVisibleRef.current = true;
          }
          // Fetch windows immediately when editor becomes active
          if (app_type === "editor") {
            await fetchWindows(bundle_id);
            // Apply window offset to prevent editor UI from being hidden behind tab bar
            if (bundle_id) {
              invoke("apply_window_offset", { bundle_id, offset_y: TAB_BAR_HEIGHT }).catch((error) => {
                console.error("Failed to apply window offset:", error);
              });
            }
          }
        } else {
          // Other app is active - hide the tab bar
          // Restore window positions before hiding
          if (currentBundleIdRef.current) {
            invoke("restore_window_positions", { bundle_id: currentBundleIdRef.current }).catch((error) => {
              console.error("Failed to restore window positions:", error);
            });
          }
          isEditorActiveRef.current = false;
          isTabManagerActiveRef.current = false;
          if (isVisibleRef.current) {
            await appWindow.hide();
            isVisibleRef.current = false;
          }
        }
      });
      cleanupFns.push(unlisten);
    };
    setupAppActivationListener();

    // Listen for show-settings event from tray menu
    const setupShowSettingsListener = async () => {
      const unlisten = await listen("show-settings", async () => {
        const monitor = await currentMonitor();
        if (monitor) {
          const screenWidth = monitor.size.width / monitor.scaleFactor;
          const screenHeight = monitor.size.height / monitor.scaleFactor;
          await appWindow.setMaxSize(new LogicalSize(screenWidth, screenHeight));
          await appWindow.setSize(new LogicalSize(600, 600));
          await appWindow.setPosition(new LogicalPosition(
            (screenWidth - 600) / 2,
            (screenHeight - 600) / 2
          ));
        }
        await appWindow.show();
        setShowSettings(true);
      });
      cleanupFns.push(unlisten);
    };
    setupShowSettingsListener();

    // No polling - all updates are event-driven via AXObserver and NSWorkspace observer

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
    };
  }, [fetchWindows, hasAccessibilityPermission]);

  const handleSettingsClose = useCallback(async () => {
    setShowSettings(false);
    // Restore to tab bar size with maxHeight restriction
    const appWindow = getCurrentWindow();
    const monitor = await currentMonitor();
    if (monitor) {
      const screenWidth = monitor.size.width / monitor.scaleFactor;
      await appWindow.setMaxSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
      await appWindow.setSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
      await appWindow.setPosition(new LogicalPosition(0, 0));
    }
  }, []);

  // アクティブタブの waiting を確認済みとして state からクリア
  useEffect(() => {
    const activeWindow = windows[activeIndex];
    if (!activeWindow) return;

    const matchingKey = Object.entries(claudeStatuses).find(
      ([path, status]) => status === "waiting" && path.split("/").pop() === activeWindow.name
    );
    if (matchingKey) {
      setClaudeStatuses(prev => {
        const next = { ...prev };
        delete next[matchingKey[0]];
        return next;
      });
    }
  }, [activeIndex, windows, claudeStatuses]);

  // 現在アクティブなタブの waiting バッジを非表示にする
  const effectiveClaudeStatuses = useMemo(() => {
    const activeWindow = windows[activeIndex];
    const filtered: Record<string, ClaudeStatus> = {};
    for (const [path, status] of Object.entries(claudeStatuses)) {
      // 現在アクティブなタブの waiting はスキップ（見えているので通知不要）
      if (status === "waiting" && activeWindow && path.split("/").pop() === activeWindow.name) {
        continue;
      }
      filtered[path] = status;
    }
    return filtered;
  }, [claudeStatuses, activeIndex, windows]);

  // Show loading state while checking permission
  if (hasAccessibilityPermission === null) {
    return null;
  }

  // Show accessibility guide if permission not granted
  if (!hasAccessibilityPermission) {
    return <AccessibilityGuide onPermissionGranted={handlePermissionGranted} />;
  }

  return (
    <>
      {!showSettings && (
        <TabBar
          tabs={windows}
          activeIndex={activeIndex}
          onTabClick={handleTabClick}
          onNewTab={handleNewTab}
          onCloseTab={handleCloseTab}
          onReorder={handleReorder}
          claudeStatuses={effectiveClaudeStatuses}
        />
      )}
      {showSettings && <Settings onClose={handleSettingsClose} />}
    </>
  );
}

export default App;
