import { useEffect, useState, useCallback, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import type { TFunction } from "i18next";
import { TAB_BAR_HEIGHT } from "../types/editor";
import type { EditorWindow, EditorState } from "../types/editor";
import {
  loadTabOrder,
  loadTabColors,
  saveTabOrder,
  saveTabColors,
  windowKey,
  sortWindowsByOrder,
} from "../utils/store";

interface UseEditorWindowsParams {
  dismissWaitingForWindow: (window: EditorWindow) => void;
  syncWaitingTimer: () => void;
  addToHistory: (windows: EditorWindow[]) => void;
  currentBundleIdRef: MutableRefObject<string | null>;
  isEditorActiveRef: MutableRefObject<boolean>;
  isVisibleRef: MutableRefObject<boolean>;
  t: TFunction;
}

interface UseEditorWindowsReturn {
  windows: EditorWindow[];
  activeIndex: number;
  tabColors: Record<string, string>;
  windowsRef: MutableRefObject<EditorWindow[]>;
  activeIndexRef: MutableRefObject<number>;
  refreshWindows: () => Promise<void>;
  refreshWindowsRef: MutableRefObject<() => Promise<void>>;
  fetchWindows: () => Promise<void>;
  fetchWindowsRef: MutableRefObject<() => Promise<void>>;
  syncActiveTab: () => Promise<void>;
  syncActiveTabRef: MutableRefObject<() => Promise<void>>;
  handleTabClick: (index: number) => void;
  handleNewTab: () => Promise<void>;
  handleCloseTab: (index: number) => Promise<void>;
  handleReorder: (from: number, to: number) => void;
  handleColorChange: (name: string, colorId: string | null) => void;
}

export function useEditorWindows({
  dismissWaitingForWindow,
  syncWaitingTimer,
  addToHistory,
  currentBundleIdRef,
  isEditorActiveRef,
  isVisibleRef,
  t,
}: UseEditorWindowsParams): UseEditorWindowsReturn {
  const [windows, setWindows] = useState<EditorWindow[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [tabColors, setTabColors] = useState<Record<string, string>>({});
  const windowsRef = useRef<EditorWindow[]>([]);
  const activeIndexRef = useRef<number>(0);
  const tabOrderRef = useRef<string[]>([]);
  const orderLoadedRef = useRef(false);
  const lastTabClickTimeRef = useRef<number>(0);

  // Keep refs in sync with state
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const refreshWindows = useCallback(async () => {
    try {
      if (!orderLoadedRef.current) {
        tabOrderRef.current = await loadTabOrder();
        orderLoadedRef.current = true;
      }

      const result = await invoke<EditorWindow[]>("get_all_editor_windows");
      const sorted = sortWindowsByOrder(result, tabOrderRef.current);
      const newOrder = sorted.map((w) => windowKey(w));
      const orderChanged =
        newOrder.length !== tabOrderRef.current.length ||
        newOrder.some((key, i) => tabOrderRef.current[i] !== key);
      if (orderChanged) {
        tabOrderRef.current = newOrder;
      }

      const currentWindows = windowsRef.current;
      const hasChanged =
        sorted.length !== currentWindows.length ||
        sorted.some(
          (w, i) =>
            currentWindows[i]?.name !== w.name ||
            currentWindows[i]?.bundle_id !== w.bundle_id ||
            currentWindows[i]?.branch !== w.branch
        );

      if (hasChanged) {
        const newKeys = new Set(sorted.map((w) => windowKey(w)));
        const disappeared = currentWindows.filter(
          (w) => !newKeys.has(windowKey(w)) && w.path
        );
        if (disappeared.length > 0) {
          addToHistory(disappeared);
        }

        setWindows(sorted);
        if (sorted.length > 0 && activeIndexRef.current >= sorted.length) {
          setActiveIndex(sorted.length - 1);
        }
      }
    } catch (error) {
      console.error("Failed to get editor windows:", error);
    }
  }, [addToHistory]);

  const syncActiveTab = useCallback(async () => {
    const timeSinceLastClick = Date.now() - lastTabClickTimeRef.current;
    if (timeSinceLastClick < 200) {
      return;
    }

    try {
      const state = await invoke<EditorState>("get_editor_state", { bundle_id: null });

      if (state.active_index !== null && state.windows.length > 0) {
        const frontmost = state.windows[state.active_index];
        const sortedIndex = windowsRef.current.findIndex(
          (w) => w.name === frontmost?.name && w.bundle_id === frontmost?.bundle_id
        );
        if (sortedIndex >= 0 && sortedIndex !== activeIndexRef.current) {
          setActiveIndex(sortedIndex);
          activeIndexRef.current = sortedIndex;
          syncWaitingTimer();
        }
      }
    } catch (error) {
      console.error("Failed to sync active tab:", error);
    }
  }, [syncWaitingTimer]);

  const handleTabClick = useCallback(
    (index: number) => {
      if (index === activeIndexRef.current) return;

      lastTabClickTimeRef.current = Date.now();
      setActiveIndex(index);
      const window = windowsRef.current[index];
      if (window) {
        dismissWaitingForWindow(window);

        invoke("focus_editor_window", { bundle_id: window.bundle_id, window_id: window.id })
          .then(() =>
            invoke("maximize_editor_window", {
              bundle_id: window.bundle_id,
              window_id: window.id,
              tab_bar_height: TAB_BAR_HEIGHT,
            })
          )
          .catch((error) => {
            console.error("Failed to focus/maximize window:", error);
          });
      }
    },
    [dismissWaitingForWindow]
  );

  const handleNewTab = useCallback(async () => {
    try {
      const bundleId = currentBundleIdRef.current;
      if (!bundleId) {
        console.warn("No bundle_id available, cannot open new editor window");
        return;
      }
      await invoke("open_new_editor", { bundle_id: bundleId });
      setTimeout(() => refreshWindowsRef.current(), 1000);
    } catch (error) {
      console.error("Failed to open new editor:", error);
    }
  }, [currentBundleIdRef]);

  const handleCloseTab = useCallback(
    async (index: number) => {
      const win = windowsRef.current[index];
      if (win) {
        const ok = await ask(t("app.closeConfirm", { name: win.name || t("app.untitled") }), {
          title: t("app.closeConfirmTitle"),
          kind: "warning",
        });
        if (!ok) return;

        try {
          await invoke("close_editor_window", { bundle_id: win.bundle_id, window_id: win.id });
          setTimeout(() => refreshWindowsRef.current(), 500);
        } catch (error) {
          console.error("Failed to close window:", error);
        }
      }
    },
    [t]
  );

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const currentWindows = windowsRef.current;
    if (
      fromIndex < 0 ||
      fromIndex >= currentWindows.length ||
      toIndex < 0 ||
      toIndex >= currentWindows.length
    ) {
      return;
    }

    const newWindows = [...currentWindows];
    const [moved] = newWindows.splice(fromIndex, 1);
    newWindows.splice(toIndex, 0, moved);

    const newOrder = newWindows.map((w) => windowKey(w));
    tabOrderRef.current = newOrder;
    saveTabOrder(newOrder);

    let newActiveIndex = activeIndexRef.current;
    if (fromIndex === activeIndexRef.current) {
      newActiveIndex = toIndex;
    } else if (fromIndex < activeIndexRef.current && toIndex >= activeIndexRef.current) {
      newActiveIndex = activeIndexRef.current - 1;
    } else if (fromIndex > activeIndexRef.current && toIndex <= activeIndexRef.current) {
      newActiveIndex = activeIndexRef.current + 1;
    }

    setWindows(newWindows);
    setActiveIndex(newActiveIndex);
  }, []);

  const handleColorChange = useCallback((windowName: string, colorId: string | null) => {
    setTabColors((prev) => {
      const next = { ...prev };
      if (colorId === null) {
        delete next[windowName];
      } else {
        next[windowName] = colorId;
      }
      saveTabColors(next);
      return next;
    });
  }, []);

  const fetchWindows = useCallback(async () => {
    try {
      if (!orderLoadedRef.current) {
        const [order, colors] = await Promise.all([loadTabOrder(), loadTabColors()]);
        tabOrderRef.current = order;
        setTabColors(colors);
        orderLoadedRef.current = true;
      }

      const result = await invoke<EditorWindow[]>("get_all_editor_windows");
      const sorted = sortWindowsByOrder(result, tabOrderRef.current);
      tabOrderRef.current = sorted.map((w) => windowKey(w));

      const currentWindows = windowsRef.current;
      const hasChanged =
        sorted.length !== currentWindows.length ||
        sorted.some(
          (w, i) =>
            currentWindows[i]?.name !== w.name ||
            currentWindows[i]?.bundle_id !== w.bundle_id ||
            currentWindows[i]?.branch !== w.branch
        );

      if (hasChanged) {
        setWindows(sorted);
        if (sorted.length > 0 && activeIndexRef.current >= sorted.length) {
          setActiveIndex(sorted.length - 1);
        }
      }

      if (sorted.length > 0) {
        addToHistory(sorted);
      }
    } catch (error) {
      console.error("Failed to fetch windows:", error);
    }
  }, [addToHistory]);

  // Refs for callback functions to avoid stale closures in event listeners
  const refreshWindowsRef = useRef(refreshWindows);
  const handleCloseTabRef = useRef(handleCloseTab);
  const handleNewTabRef = useRef(handleNewTab);
  const syncActiveTabRef = useRef(syncActiveTab);
  const fetchWindowsRef = useRef(fetchWindows);

  useEffect(() => {
    refreshWindowsRef.current = refreshWindows;
  }, [refreshWindows]);
  useEffect(() => {
    handleCloseTabRef.current = handleCloseTab;
  }, [handleCloseTab]);
  useEffect(() => {
    handleNewTabRef.current = handleNewTab;
  }, [handleNewTab]);
  useEffect(() => {
    syncActiveTabRef.current = syncActiveTab;
  }, [syncActiveTab]);
  useEffect(() => {
    fetchWindowsRef.current = fetchWindows;
  }, [fetchWindows]);

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

      const unlistenNewTab = await listen("open-new-editor-tab", () => {
        if (isMounted) {
          handleNewTabRef.current();
        }
      });
      cleanupFns.push(unlistenNewTab);

      const unlistenClose = await listen("close-current-tab", () => {
        if (isMounted) {
          const currentIndex = activeIndexRef.current;
          const win = windowsRef.current[currentIndex];
          if (win) {
            invoke("close_editor_window", { bundle_id: win.bundle_id, window_id: win.id });
            setTimeout(() => refreshWindowsRef.current(), 500);
          }
        }
      });
      cleanupFns.push(unlistenClose);

      const unlistenSwitch = await listen<number>("switch-to-tab", (event) => {
        if (isMounted && event.payload < windowsRef.current.length) {
          setActiveIndex(event.payload);
          activeIndexRef.current = event.payload;
          syncWaitingTimer();
          const win = windowsRef.current[event.payload];
          if (win) {
            invoke("focus_editor_window", { bundle_id: win.bundle_id, window_id: win.id }).then(
              () =>
                invoke("maximize_editor_window", {
                  bundle_id: win.bundle_id,
                  window_id: win.id,
                  tab_bar_height: TAB_BAR_HEIGHT,
                })
            );
          }
        }
      });
      cleanupFns.push(unlistenSwitch);

      const unlistenWindowFocus = await listen("window-focus-changed", async () => {
        if (!isMounted || !isEditorActiveRef.current) return;
        syncActiveTabRef.current();
        if (!isVisibleRef.current) {
          const appWindow = getCurrentWindow();
          await appWindow.show();
        }
      });
      cleanupFns.push(unlistenWindowFocus);

      const unlistenWindowsChanged = await listen("windows-changed", () => {
        if (!isMounted || !isEditorActiveRef.current) return;
        refreshWindowsRef.current();
      });
      cleanupFns.push(unlistenWindowsChanged);
    };

    setupListeners();

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
    };
  }, [syncWaitingTimer, isEditorActiveRef, isVisibleRef]);

  return {
    windows,
    activeIndex,
    tabColors,
    windowsRef,
    activeIndexRef,
    refreshWindows,
    refreshWindowsRef,
    fetchWindows,
    fetchWindowsRef,
    syncActiveTab,
    syncActiveTabRef,
    handleTabClick,
    handleNewTab,
    handleCloseTab,
    handleReorder,
    handleColorChange,
  };
}
