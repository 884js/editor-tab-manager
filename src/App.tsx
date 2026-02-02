import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { currentMonitor } from "@tauri-apps/api/window";
import TabBar from "./components/TabBar";

export interface VSCodeWindow {
  id: number;
  name: string;
  path: string;
}

interface VSCodeState {
  is_active: boolean;
  windows: VSCodeWindow[];
  active_index: number | null;  // Index of the frontmost window after sorting
}

const TAB_ORDER_KEY = "vscode-tab-manager-order";

// Load tab order from localStorage
function loadTabOrder(): string[] {
  try {
    const saved = localStorage.getItem(TAB_ORDER_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

// Save tab order to localStorage
function saveTabOrder(order: string[]): void {
  localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
}

// Sort windows by custom order, new windows go to the end
function sortWindowsByOrder(windows: VSCodeWindow[], order: string[]): VSCodeWindow[] {
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

function App() {
  const [windows, setWindows] = useState<VSCodeWindow[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const windowsRef = useRef<VSCodeWindow[]>([]);
  const activeIndexRef = useRef<number>(0);
  const isVisibleRef = useRef(true);
  const isInitializedRef = useRef(false);
  const tabOrderRef = useRef<string[]>(loadTabOrder());

  // Keep refs in sync with state
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const refreshWindows = useCallback(async () => {
    try {
      const result = await invoke<VSCodeWindow[]>("get_vscode_windows");
      // Sort by custom order
      const sorted = sortWindowsByOrder(result, tabOrderRef.current);
      // Update order with current windows (remove deleted, keep order for existing)
      const newOrder = sorted.map(w => w.name);
      tabOrderRef.current = newOrder;
      saveTabOrder(newOrder);

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
      console.error("Failed to get VSCode windows:", error);
    }
  }, []);

  // Optimized: Single polling for both windows and visibility
  const pollVSCodeState = useCallback(async (appWindow: ReturnType<typeof getCurrentWindow>) => {
    try {
      const state = await invoke<VSCodeState>("get_vscode_state");

      // Update visibility
      if (state.is_active && !isVisibleRef.current) {
        await appWindow.show();
        isVisibleRef.current = true;
      } else if (!state.is_active && isVisibleRef.current) {
        await appWindow.hide();
        isVisibleRef.current = false;
      }

      // Sort by custom order
      const sorted = sortWindowsByOrder(state.windows, tabOrderRef.current);
      // Update order with current windows (remove deleted, keep order for existing)
      const newOrder = sorted.map(w => w.name);
      tabOrderRef.current = newOrder;
      saveTabOrder(newOrder);

      // Update windows only if changed (compare by name only, not path)
      const currentWindows = windowsRef.current;
      const hasChanged = sorted.length !== currentWindows.length ||
        sorted.some((w, i) => currentWindows[i]?.name !== w.name);

      if (hasChanged) {
        setWindows(sorted);
        // On first load, set activeIndex to the frontmost window
        if (!isInitializedRef.current && state.active_index !== null) {
          // Find the frontmost window's position in the sorted array
          const frontmostName = state.windows[state.active_index]?.name;
          const sortedIndex = sorted.findIndex(w => w.name === frontmostName);
          setActiveIndex(sortedIndex >= 0 ? sortedIndex : 0);
          isInitializedRef.current = true;
        } else if (sorted.length > 0 && activeIndexRef.current >= sorted.length) {
          setActiveIndex(sorted.length - 1);
        }
      } else {
        // Update ref with new ids without triggering re-render
        windowsRef.current = sorted;
      }
    } catch (error) {
      console.error("Failed to poll VSCode state:", error);
    }
  }, []);


  const handleTabClick = useCallback((index: number) => {
    setActiveIndex(index);
    const window = windowsRef.current[index];
    if (window) {
      // Fire-and-forget: don't await, let UI respond immediately
      invoke("focus_vscode_window", { window_id: window.id }).catch((error) => {
        console.error("Failed to focus window:", error);
      });
    }
  }, []);

  const handleNewTab = useCallback(async () => {
    try {
      await invoke("open_new_vscode");
      setTimeout(refreshWindows, 1000);
    } catch (error) {
      console.error("Failed to open new VSCode:", error);
    }
  }, [refreshWindows]);

  const handleCloseTab = useCallback(async (index: number) => {
    const window = windowsRef.current[index];
    if (window) {
      try {
        await invoke("close_vscode_window", { window_id: window.id });
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

    // Update order and save
    const newOrder = newWindows.map(w => w.name);
    tabOrderRef.current = newOrder;
    saveTabOrder(newOrder);

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

  useEffect(() => {
    refreshWindowsRef.current = refreshWindows;
  }, [refreshWindows]);

  useEffect(() => {
    handleCloseTabRef.current = handleCloseTab;
  }, [handleCloseTab]);

  useEffect(() => {
    handleTabClickRef.current = handleTabClick;
  }, [handleTabClick]);

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

      const unlistenClose = await listen("close-current-tab", () => {
        if (isMounted) {
          const currentIndex = activeIndexRef.current;
          const currentWindows = windowsRef.current;
          if (currentWindows[currentIndex]) {
            invoke("close_vscode_window", { window_id: currentWindows[currentIndex].id });
            setTimeout(() => refreshWindowsRef.current(), 500);
          }
        }
      });
      cleanupFns.push(unlistenClose);

      const unlistenSwitch = await listen<number>("switch-to-tab", (event) => {
        if (isMounted && event.payload < windowsRef.current.length) {
          setActiveIndex(event.payload);
          const win = windowsRef.current[event.payload];
          if (win) {
            invoke("focus_vscode_window", { window_id: win.id });
          }
        }
      });
      cleanupFns.push(unlistenSwitch);
    };

    setupListeners();

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
    };
  }, []); // Empty dependency array - listeners set up once

  // Unified polling: windows + visibility in single AppleScript call
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let intervalId: ReturnType<typeof setInterval> | null = null;

    // Initialize window on startup
    const initWindow = async () => {
      const monitor = await currentMonitor();
      if (monitor) {
        const screenWidth = monitor.size.width / monitor.scaleFactor;
        await appWindow.setSize(new LogicalSize(screenWidth, 36));
        await appWindow.setPosition(new LogicalPosition(0, 0));
      }
      await appWindow.show();
      isVisibleRef.current = true;

      // Initial fetch
      await pollVSCodeState(appWindow);
    };
    initWindow();

    // Start unified polling after delay
    const startDelay = setTimeout(() => {
      intervalId = setInterval(() => pollVSCodeState(appWindow), 500);
    }, 2000);

    return () => {
      clearTimeout(startDelay);
      if (intervalId) clearInterval(intervalId);
    };
  }, [pollVSCodeState]);

  return (
    <TabBar
      tabs={windows}
      activeIndex={activeIndex}
      onTabClick={handleTabClick}
      onNewTab={handleNewTab}
      onCloseTab={handleCloseTab}
      onReorder={handleReorder}
    />
  );
}

export default App;
