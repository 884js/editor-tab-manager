import { useEffect, useState, useCallback, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import type { TFunction } from "i18next";
import { TAB_BAR_HEIGHT, ALL_EDITOR_BUNDLE_IDS } from "../types/editor";
import type { EditorWindow, EditorState, GroupDefinition, GroupAssignment } from "../types/editor";
import {
  loadTabOrder,
  loadTabColors,
  saveTabOrder,
  saveTabColors,
  windowKey,
  sortWindowsByOrder,
  loadGroups,
  saveGroups,
  loadGroupAssignments,
  saveGroupAssignments,
  loadCollapsedGroups,
  saveCollapsedGroups,
  loadGroupColors,
  saveGroupColors,
} from "../utils/store";

interface UseEditorWindowsParams {
  dismissWaitingForWindow: (window: EditorWindow) => void;
  syncWaitingTimer: () => void;
  addToHistory: (windows: EditorWindow[]) => void;
  currentBundleIdRef: MutableRefObject<string | null>;
  isEditorActiveRef: MutableRefObject<boolean>;
  isTabManagerActiveRef: MutableRefObject<boolean>;
  isVisibleRef: MutableRefObject<boolean>;
  t: TFunction;
}

interface UseEditorWindowsReturn {
  windows: EditorWindow[];
  activeIndex: number;
  tabColors: Record<string, string>;
  groups: GroupDefinition[];
  groupAssignments: GroupAssignment;
  collapsedGroups: Set<string>;
  groupColors: Record<string, string>;
  windowsRef: MutableRefObject<EditorWindow[]>;
  activeIndexRef: MutableRefObject<number>;
  refreshWindows: () => Promise<void>;
  refreshWindowsRef: MutableRefObject<() => Promise<void>>;
  fetchWindows: () => Promise<number>;
  fetchWindowsRef: MutableRefObject<() => Promise<number>>;
  syncActiveTab: () => Promise<void>;
  syncActiveTabRef: MutableRefObject<() => Promise<void>>;
  handleTabClick: (index: number) => void;
  handleNewTab: () => Promise<void>;
  handleCloseTab: (index: number) => Promise<void>;
  handleReorder: (from: number, to: number) => void;
  handleColorChange: (name: string, colorId: string | null) => void;
  addGroup: (name: string) => string;
  updateGroup: (groupId: string, name: string) => void;
  deleteGroup: (groupId: string) => void;
  assignTabToGroup: (wKey: string, groupId: string) => void;
  unassignTabFromGroup: (wKey: string) => void;
  toggleGroupCollapse: (groupId: string) => void;
  reorderGroups: (fromIndex: number, toIndex: number) => void;
  setGroupColor: (groupId: string, colorId: string | null) => void;
}

export function useEditorWindows({
  dismissWaitingForWindow,
  syncWaitingTimer,
  addToHistory,
  currentBundleIdRef,
  isEditorActiveRef,
  isTabManagerActiveRef,
  isVisibleRef,
  t,
}: UseEditorWindowsParams): UseEditorWindowsReturn {
  const [windows, setWindows] = useState<EditorWindow[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [tabColors, setTabColors] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<GroupDefinition[]>([]);
  const [groupAssignments, setGroupAssignments] = useState<GroupAssignment>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupColors, setGroupColors] = useState<Record<string, string>>({});
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
        // Skip clearing windows on transient AX API empty response
        if (sorted.length === 0 && currentWindows.length > 0) {
          return;
        }

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
      const bundleId = currentBundleIdRef.current ?? null;
      const state = await invoke<EditorState>("get_editor_state", { bundle_id: bundleId });

      if (state.active_index !== null && state.windows.length > 0) {
        const frontmost = state.windows[state.active_index];
        const sortedIndex = windowsRef.current.findIndex(
          (w) => w.id === frontmost?.id
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

  const addGroup = useCallback((name: string): string => {
    const id = crypto.randomUUID();
    setGroups((prev) => {
      const newGroup: GroupDefinition = {
        id,
        name,
        order: prev.length,
      };
      const next = [...prev, newGroup];
      saveGroups(next);
      return next;
    });
    return id;
  }, []);

  const updateGroup = useCallback((groupId: string, name: string) => {
    setGroups((prev) => {
      const next = prev.map((g) => (g.id === groupId ? { ...g, name } : g));
      saveGroups(next);
      return next;
    });
  }, []);

  const deleteGroup = useCallback((groupId: string) => {
    setGroups((prev) => {
      const next = prev
        .filter((g) => g.id !== groupId)
        .map((g, i) => ({ ...g, order: i }));
      saveGroups(next);
      return next;
    });
    setGroupAssignments((prev) => {
      const next: GroupAssignment = {};
      for (const [key, gid] of Object.entries(prev)) {
        if (gid !== groupId) next[key] = gid;
      }
      saveGroupAssignments(next);
      return next;
    });
    setCollapsedGroups((prev) => {
      if (!prev.has(groupId)) return prev;
      const next = new Set(prev);
      next.delete(groupId);
      saveCollapsedGroups([...next]);
      return next;
    });
  }, []);

  const assignTabToGroup = useCallback((wKey: string, groupId: string) => {
    setGroupAssignments((prev) => {
      const next = { ...prev, [wKey]: groupId };
      saveGroupAssignments(next);
      return next;
    });
  }, []);

  const unassignTabFromGroup = useCallback((wKey: string) => {
    setGroupAssignments((prev) => {
      const next = { ...prev };
      delete next[wKey];
      saveGroupAssignments(next);
      return next;
    });
  }, []);

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      saveCollapsedGroups([...next]);
      return next;
    });
  }, []);

  const reorderGroups = useCallback((fromIndex: number, toIndex: number) => {
    setGroups((prev) => {
      if (fromIndex < 0 || fromIndex >= prev.length || toIndex < 0 || toIndex >= prev.length) {
        return prev;
      }
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const [moved] = sorted.splice(fromIndex, 1);
      sorted.splice(toIndex, 0, moved);
      const next = sorted.map((g, i) => ({ ...g, order: i }));
      saveGroups(next);
      return next;
    });
  }, []);

  const setGroupColor = useCallback((groupId: string, colorId: string | null) => {
    setGroupColors((prev) => {
      const next = { ...prev };
      if (colorId === null) {
        delete next[groupId];
      } else {
        next[groupId] = colorId;
      }
      saveGroupColors(next);
      return next;
    });
  }, []);

  const fetchWindows = useCallback(async (): Promise<number> => {
    try {
      if (!orderLoadedRef.current) {
        const [order, colors, grps, assigns, collapsed, grpColors] = await Promise.all([
          loadTabOrder(),
          loadTabColors(),
          loadGroups(),
          loadGroupAssignments(),
          loadCollapsedGroups(),
          loadGroupColors(),
        ]);
        tabOrderRef.current = order;
        setTabColors(colors);
        setGroups(grps);
        setGroupAssignments(assigns);
        setCollapsedGroups(new Set(collapsed));
        setGroupColors(grpColors);
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
        // Skip clearing windows on transient AX API empty response
        if (sorted.length === 0 && currentWindows.length > 0) {
          return 0;
        }
        setWindows(sorted);
        if (sorted.length > 0 && activeIndexRef.current >= sorted.length) {
          setActiveIndex(sorted.length - 1);
        }
      }

      if (sorted.length > 0) {
        addToHistory(sorted);
      }

      return sorted.length;
    } catch (error) {
      console.error("Failed to fetch windows:", error);
      return 0;
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
        if (!isMounted) return;

        // Approach 6: AX Observer only monitors editor processes, so this event
        // confirms an editor is active. If isEditorActiveRef is false, recover
        // the editor-active state as a fallback for missed observer.rs events.
        if (!isEditorActiveRef.current) {
          isEditorActiveRef.current = true;
          isTabManagerActiveRef.current = false;
        }

        syncActiveTabRef.current();

        // Approach 4: Position-based visibility recovery
        if (!isVisibleRef.current) {
          const appWindow = getCurrentWindow();
          await appWindow.setPosition(new PhysicalPosition(0, 0));
          isVisibleRef.current = true;
          for (const bid of ALL_EDITOR_BUNDLE_IDS) {
            invoke("apply_window_offset", { bundle_id: bid, offset_y: TAB_BAR_HEIGHT }).catch(
              () => {}
            );
          }
          await fetchWindowsRef.current();
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
  }, [syncWaitingTimer, isEditorActiveRef, isTabManagerActiveRef, isVisibleRef]);

  return {
    windows,
    activeIndex,
    tabColors,
    groups,
    groupAssignments,
    collapsedGroups,
    groupColors,
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
    addGroup,
    updateGroup,
    deleteGroup,
    assignTabToGroup,
    unassignTabFromGroup,
    toggleGroupCollapse,
    reorderGroups,
    setGroupColor,
  };
}
