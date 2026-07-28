import { useEffect, useState, useCallback, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import type { TFunction } from "i18next";
import { TAB_BAR_HEIGHT, ALL_EDITOR_BUNDLE_IDS, EDITOR_DISPLAY_NAMES } from "../types/editor";
import type { EditorWindow, WindowsSnapshot, GroupDefinition, GroupAssignment, ProjectEditorBundleId, ProjectMetadata, SavedTab, TabColorMap } from "../types/editor";
import {
  loadTabOrder,
  loadTabColors,
  loadHistory,
  loadSavedTabs,
  saveTabOrder,
  saveTabColors,
  saveSavedTabs,
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
  legacyWindowKey,
  migrateResolvedWindowKeys,
  normalizeProjectPath,
  runtimeWindowKey,
} from "../utils/store";
import {
  migrateSavedTabKeys,
  migrateLegacySavedTabs,
  mergeProjectMetadata,
  reconcilePersistentTabs,
  savedTabKey,
  savedTabsDiffer,
} from "../utils/persistentTabs";

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
  tabColors: TabColorMap;
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
  handleNewTab: (bundleId?: ProjectEditorBundleId) => Promise<boolean>;
  handleOpenProject: (path: string, bundleId: ProjectEditorBundleId) => Promise<boolean>;
  handleOpenSavedTab: (
    index: number,
    bundleId: ProjectEditorBundleId,
    groupId?: string,
  ) => Promise<boolean>;
  handleCloseTab: (index: number) => Promise<void>;
  handleReorder: (from: number, to: number) => void;
  handleReorderByVisual: (visualOrder: number[]) => void;
  handleColorChange: (windowKey: string, colorId: string | null) => void;
  addGroup: (name: string) => string;
  updateGroup: (groupId: string, name: string) => void;
  deleteGroup: (groupId: string) => void;
  assignTabsToGroup: (wKeys: string[], groupId: string) => void;
  unassignTabsFromGroup: (wKeys: string[]) => void;
  toggleGroupCollapse: (groupId: string) => void;
  reorderGroups: (fromIndex: number, toIndex: number) => void;
  setGroupColor: (groupId: string, colorId: string | null) => void;
}

function editorWindowListsDiffer(next: EditorWindow[], current: EditorWindow[]): boolean {
  return next.length !== current.length || next.some((window, index) => {
    const previous = current[index];
    return !previous ||
      runtimeWindowKey(previous) !== runtimeWindowKey(window) ||
      previous.name !== window.name ||
      previous.path !== window.path ||
      previous.branch !== window.branch ||
      previous.repository_id !== window.repository_id ||
      previous.repository_name !== window.repository_name ||
      previous.bundle_id !== window.bundle_id ||
      previous.editor_name !== window.editor_name ||
      previous.resolution !== window.resolution ||
      previous.is_open !== window.is_open ||
      previous.open_error !== window.open_error;
  });
}

function stringListsDiffer(a: string[], b: string[]): boolean {
  return a.length !== b.length || a.some((value, index) => value !== b[index]);
}

function normalizeSnapshot(payload: WindowsSnapshot | EditorWindow[]): WindowsSnapshot {
  if (Array.isArray(payload)) {
    return { revision: 0, windows: payload, active_id: null, source: "legacy" };
  }
  return payload;
}

function isAppliedStructuredSnapshot(
  payload: WindowsSnapshot | EditorWindow[],
  lastRevision: number,
): boolean {
  return !Array.isArray(payload) && payload.revision <= lastRevision;
}

function isLegacyNameOrderKey(key: string): boolean {
  return ALL_EDITOR_BUNDLE_IDS.some((bundleId) => {
    const prefix = `${bundleId}:`;
    if (!key.startsWith(prefix)) return false;
    const identity = key.slice(prefix.length);
    return Boolean(identity) &&
      !identity.startsWith("/") &&
      !identity.startsWith("runtime:");
  });
}

function mergeOrderWithUnresolvedLegacyKeys(
  currentOrder: string[],
  tabs: EditorWindow[],
): string[] {
  const nextKeys = [...new Set(tabs.map(windowKey))];
  const nextKeySet = new Set(nextKeys);
  const pathKeysByLegacyKey = new Map<string, Set<string>>();
  for (const tab of tabs) {
    if (!tab.path) continue;
    const key = legacyWindowKey(tab);
    const pathKeys = pathKeysByLegacyKey.get(key) ?? new Set<string>();
    pathKeys.add(windowKey(tab));
    pathKeysByLegacyKey.set(key, pathKeys);
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  const append = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(key);
  };

  for (const key of currentOrder) {
    if (nextKeySet.has(key)) {
      append(key);
      continue;
    }

    const replacements = pathKeysByLegacyKey.get(key);
    if (replacements?.size === 1) {
      append([...replacements][0]);
      continue;
    }

    if (isLegacyNameOrderKey(key)) {
      append(key);
    }
  }

  for (const key of nextKeys) {
    append(key);
  }
  return merged;
}

function mergeReorderedTabsWithUnresolvedLegacyKeys(
  currentOrder: string[],
  tabs: EditorWindow[],
): string[] {
  const reorderedKeys = [...new Set(tabs.map(windowKey))];
  const reorderedKeySet = new Set(reorderedKeys);
  const pathKeysByLegacyKey = new Map<string, Set<string>>();
  for (const tab of tabs) {
    if (!tab.path) continue;
    const key = legacyWindowKey(tab);
    const pathKeys = pathKeysByLegacyKey.get(key) ?? new Set<string>();
    pathKeys.add(windowKey(tab));
    pathKeysByLegacyKey.set(key, pathKeys);
  }
  const unresolvedLegacyKeys = new Set(
    currentOrder.filter(
      (key) =>
        isLegacyNameOrderKey(key) &&
        pathKeysByLegacyKey.get(key)?.size !== 1,
    ),
  );
  const merged: string[] = [];
  const seen = new Set<string>();
  let reorderedIndex = 0;
  const append = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(key);
  };

  for (const key of currentOrder) {
    if (unresolvedLegacyKeys.has(key)) {
      append(key);
    } else if (reorderedKeySet.has(key) && reorderedIndex < reorderedKeys.length) {
      append(reorderedKeys[reorderedIndex]);
      reorderedIndex += 1;
    }
  }
  while (reorderedIndex < reorderedKeys.length) {
    append(reorderedKeys[reorderedIndex]);
    reorderedIndex += 1;
  }
  return merged;
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
  const [tabColors, setTabColors] = useState<TabColorMap>({});
  const [groups, setGroups] = useState<GroupDefinition[]>([]);
  const [groupAssignments, setGroupAssignments] = useState<GroupAssignment>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupColors, setGroupColors] = useState<Record<string, string>>({});
  const windowsRef = useRef<EditorWindow[]>([]);
  const liveWindowsRef = useRef<EditorWindow[]>([]);
  const savedTabsRef = useRef<SavedTab[]>([]);
  const activeIndexRef = useRef<number>(0);
  const tabOrderRef = useRef<string[]>([]);
  const orderLoadedRef = useRef(false);
  const stateLoadPromiseRef = useRef<Promise<void> | null>(null);
  const lastTabClickTimeRef = useRef<number>(0);
  const lastSnapshotRevisionRef = useRef<number>(-1);

  // Keep refs in sync with state
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const ensureStateLoaded = useCallback(async () => {
    if (orderLoadedRef.current) return;

    if (!stateLoadPromiseRef.current) {
      stateLoadPromiseRef.current = (async () => {
        const [order, colors, savedTabs, history, grps, assigns, collapsed, grpColors] = await Promise.all([
          loadTabOrder(),
          loadTabColors(),
          loadSavedTabs(),
          loadHistory(),
          loadGroups(),
          loadGroupAssignments(),
          loadCollapsedGroups(),
          loadGroupColors(),
        ]);
        const migratedSavedTabs = migrateLegacySavedTabs(savedTabs, order, history);
        tabOrderRef.current = order;
        savedTabsRef.current = migratedSavedTabs;
        const restoredTabs = sortWindowsByOrder(
          reconcilePersistentTabs(migratedSavedTabs, []).tabs,
          order,
        );
        windowsRef.current = restoredTabs;
        setWindows(restoredTabs);
        setTabColors(colors);
        setGroups(grps);
        setGroupAssignments(assigns);
        setCollapsedGroups(new Set(collapsed));
        setGroupColors(grpColors);

        const metadataPaths = [...new Set(
          migratedSavedTabs
            .map((tab) => normalizeProjectPath(tab.path))
            .filter(Boolean),
        )];
        let initialSavedTabs = migratedSavedTabs;
        if (metadataPaths.length > 0) {
          try {
            const metadata = await invoke<ProjectMetadata[]>("get_project_metadata", {
              paths: metadataPaths,
            });
            initialSavedTabs = mergeProjectMetadata(migratedSavedTabs, metadata);
          } catch (error) {
            console.error("Failed to load project metadata:", error);
          }
        }
        savedTabsRef.current = initialSavedTabs;
        const tabsWithMetadata = sortWindowsByOrder(
          reconcilePersistentTabs(initialSavedTabs, []).tabs,
          order,
        );
        windowsRef.current = tabsWithMetadata;
        setWindows(tabsWithMetadata);
        if (savedTabsDiffer(initialSavedTabs, savedTabs)) {
          void saveSavedTabs(initialSavedTabs);
        }
        orderLoadedRef.current = true;
      })();
    }

    try {
      await stateLoadPromiseRef.current;
    } catch (error) {
      stateLoadPromiseRef.current = null;
      throw error;
    }
  }, []);

  const applySnapshot = useCallback((snapshot: WindowsSnapshot): EditorWindow[] => {
    const nextLiveWindows = snapshot.windows.map((window) => ({ ...window, is_open: true }));
    const currentLiveWindows = liveWindowsRef.current;

    const migratedOrder = migrateResolvedWindowKeys(
      tabOrderRef.current,
      currentLiveWindows,
      nextLiveWindows,
    );
    if (stringListsDiffer(migratedOrder, tabOrderRef.current)) {
      void saveTabOrder(migratedOrder);
    }
    tabOrderRef.current = migratedOrder;

    const migratedSavedTabs = migrateSavedTabKeys(
      savedTabsRef.current,
      currentLiveWindows,
      nextLiveWindows,
    );
    const reconciled = reconcilePersistentTabs(migratedSavedTabs, nextLiveWindows);
    if (savedTabsDiffer(reconciled.savedTabs, savedTabsRef.current)) {
      savedTabsRef.current = reconciled.savedTabs;
      void saveSavedTabs(reconciled.savedTabs);
    } else {
      savedTabsRef.current = reconciled.savedTabs;
    }

    const sorted = sortWindowsByOrder(reconciled.tabs, tabOrderRef.current);
    const newOrder = mergeOrderWithUnresolvedLegacyKeys(
      tabOrderRef.current,
      sorted,
    );
    if (stringListsDiffer(newOrder, tabOrderRef.current)) {
      tabOrderRef.current = newOrder;
      void saveTabOrder(newOrder);
    }

    const nextWindowKeys = new Set(nextLiveWindows.map(windowKey));
    const nextRuntimeKeys = new Set(nextLiveWindows.map(runtimeWindowKey));
    const disappeared = currentLiveWindows.filter(
      (window) =>
        window.path &&
        !nextWindowKeys.has(windowKey(window)) &&
        !nextRuntimeKeys.has(runtimeWindowKey(window)),
    );
    if (disappeared.length > 0) {
      addToHistory(disappeared);
    }

    liveWindowsRef.current = nextLiveWindows;
    const currentWindows = windowsRef.current;
    windowsRef.current = sorted;
    if (editorWindowListsDiffer(sorted, currentWindows)) {
      setWindows(sorted);
    }

    if (sorted.length === 0) {
      activeIndexRef.current = 0;
      setActiveIndex(0);
    } else if (activeIndexRef.current >= sorted.length) {
      activeIndexRef.current = sorted.length - 1;
      setActiveIndex(sorted.length - 1);
    }

    return sorted;
  }, [addToHistory]);

  const refreshWindows = useCallback(async () => {
    try {
      await ensureStateLoaded();
      const payload = await invoke<WindowsSnapshot | EditorWindow[]>("get_windows_snapshot");
      const snapshot = normalizeSnapshot(payload);
      void invoke("request_windows_refresh");
      if (isAppliedStructuredSnapshot(payload, lastSnapshotRevisionRef.current)) {
        return;
      }
      lastSnapshotRevisionRef.current = Math.max(
        lastSnapshotRevisionRef.current,
        snapshot.revision,
      );
      applySnapshot(snapshot);
    } catch (error) {
      console.error("Failed to get editor windows:", error);
    }
  }, [applySnapshot, ensureStateLoaded]);

  const syncActiveTab = useCallback(async () => {
    const timeSinceLastClick = Date.now() - lastTabClickTimeRef.current;
    if (timeSinceLastClick < 200) {
      return;
    }

    try {
      const payload = await invoke<WindowsSnapshot | EditorWindow[]>("get_windows_snapshot");
      const snapshot = normalizeSnapshot(payload);
      if (
        !Array.isArray(payload) &&
        payload.revision < lastSnapshotRevisionRef.current
      ) {
        return;
      }

      if (snapshot.active_id !== null && snapshot.windows.length > 0) {
        const frontmost = snapshot.windows.find((window) => window.id === snapshot.active_id);
        const sortedIndex = windowsRef.current.findIndex(
          (w) => runtimeWindowKey(w) === (frontmost ? runtimeWindowKey(frontmost) : "")
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

  const focusLiveWindow = useCallback(
    async (window: EditorWindow, index: number) => {
      lastTabClickTimeRef.current = Date.now();
      setActiveIndex(index);
      activeIndexRef.current = index;
      dismissWaitingForWindow(window);
      try {
        await invoke("focus_editor_window", {
          bundle_id: window.bundle_id,
          window_id: window.id,
        });
        await invoke("maximize_editor_window", {
          bundle_id: window.bundle_id,
          window_id: window.id,
          tab_bar_height: TAB_BAR_HEIGHT,
        });
        return true;
      } catch (error) {
        console.error("Failed to focus/maximize window:", error);
        return false;
      }
    },
    [dismissWaitingForWindow]
  );

  const handleTabClick = useCallback(
    (index: number) => {
      const window = windowsRef.current[index];
      if (!window || window.is_open === false) return;
      if (index === activeIndexRef.current) return;
      void focusLiveWindow(window, index);
    },
    [focusLiveWindow]
  );

  const handleOpenProject = useCallback(
    async (path: string, bundleId: ProjectEditorBundleId) => {
      const normalizedPath = normalizeProjectPath(path);
      const existingIndex = windowsRef.current.findIndex(
        (window) =>
          window.is_open !== false &&
          window.bundle_id === bundleId &&
          normalizeProjectPath(window.path) === normalizedPath,
      );
      if (existingIndex >= 0) {
        return focusLiveWindow(windowsRef.current[existingIndex], existingIndex);
      }

      try {
        await invoke("open_project_in_editor", {
          bundle_id: bundleId,
          path: normalizedPath,
        });
        setTimeout(() => refreshWindowsRef.current(), 1000);
        return true;
      } catch (error) {
        console.error("Failed to open project:", error);
        return false;
      }
    },
    [focusLiveWindow],
  );

  const handleOpenSavedTab = useCallback(
    async (
      index: number,
      bundleId: ProjectEditorBundleId,
      displayedGroupId?: string,
    ) => {
      await ensureStateLoaded();
      const savedWindow = windowsRef.current[index];
      if (!savedWindow?.path) return false;
      if (savedWindow.is_open !== false) {
        return focusLiveWindow(savedWindow, index);
      }

      const sourceKey = windowKey(savedWindow);
      const retargetedTab: SavedTab = {
        name: savedWindow.name,
        path: normalizeProjectPath(savedWindow.path),
        branch: savedWindow.branch,
        repository_id: savedWindow.repository_id,
        repository_name: savedWindow.repository_name,
        bundle_id: bundleId,
        editor_name: EDITOR_DISPLAY_NAMES[bundleId],
        resolution: savedWindow.resolution,
      };
      const targetKey = savedTabKey(retargetedTab);
      const targetAlreadySaved = savedTabsRef.current.some(
        (tab) => savedTabKey(tab) === targetKey && savedTabKey(tab) !== sourceKey,
      );
      let sourceReplaced = false;
      const nextSavedTabs = savedTabsRef.current.flatMap((tab) => {
        if (savedTabKey(tab) !== sourceKey) return [tab];
        sourceReplaced = true;
        return targetAlreadySaved ? [] : [retargetedTab];
      });
      if (!sourceReplaced && !targetAlreadySaved) {
        nextSavedTabs.push(retargetedTab);
      }

      savedTabsRef.current = nextSavedTabs;
      void saveSavedTabs(nextSavedTabs);

      if (sourceKey !== targetKey) {
        const targetAlreadyOrdered = tabOrderRef.current.includes(targetKey);
        const nextOrder = tabOrderRef.current.flatMap((key) => {
          if (key !== sourceKey) return [key];
          return targetAlreadyOrdered ? [] : [targetKey];
        });
        tabOrderRef.current = [...new Set(nextOrder)];
        void saveTabOrder(tabOrderRef.current);

        setGroupAssignments((currentAssignments) => {
          const sourceGroupId = displayedGroupId ?? (
            Object.prototype.hasOwnProperty.call(currentAssignments, sourceKey)
              ? currentAssignments[sourceKey]
              : currentAssignments[legacyWindowKey(savedWindow)]
          );
          if (sourceGroupId === undefined) return currentAssignments;

          const nextAssignments = { ...currentAssignments };
          delete nextAssignments[sourceKey];
          nextAssignments[targetKey] = sourceGroupId;
          void saveGroupAssignments(nextAssignments);
          return nextAssignments;
        });
      }

      const reconciled = reconcilePersistentTabs(nextSavedTabs, liveWindowsRef.current);
      const sorted = sortWindowsByOrder(reconciled.tabs, tabOrderRef.current);
      windowsRef.current = sorted;
      setWindows(sorted);

      const targetIndex = sorted.findIndex((window) => windowKey(window) === targetKey);
      if (targetIndex >= 0) {
        activeIndexRef.current = targetIndex;
        setActiveIndex(targetIndex);
      }

      const opened = await handleOpenProject(retargetedTab.path, bundleId);
      if (!opened) {
        const errorWindows = windowsRef.current.map((window) =>
          windowKey(window) === targetKey ? { ...window, open_error: true } : window
        );
        windowsRef.current = errorWindows;
        setWindows(errorWindows);
      }
      return opened;
    },
    [ensureStateLoaded, focusLiveWindow, handleOpenProject],
  );

  const handleNewTab = useCallback(async (selectedBundleId?: ProjectEditorBundleId) => {
    try {
      const bundleId = selectedBundleId ?? currentBundleIdRef.current;
      if (!bundleId) {
        console.warn("No bundle_id available, cannot open new editor window");
        return false;
      }
      await invoke("open_new_editor", { bundle_id: bundleId });
      setTimeout(() => refreshWindowsRef.current(), 1000);
      return true;
    } catch (error) {
      console.error("Failed to open new editor:", error);
      return false;
    }
  }, [currentBundleIdRef]);

  const handleCloseTab = useCallback(
    async (index: number) => {
      const win = windowsRef.current[index];
      if (win) {
        const confirmKey = win.is_open === false
          ? "app.removeTabConfirm"
          : "app.closeAndRemoveConfirm";
        const ok = await ask(t(confirmKey, { name: win.name || t("app.untitled") }), {
          title: t("app.closeConfirmTitle"),
          kind: "warning",
        });
        if (!ok) return;

        try {
          if (win.is_open !== false) {
            await invoke("close_editor_window", { bundle_id: win.bundle_id, window_id: win.id });
          }

          const key = windowKey(win);
          const nextSavedTabs = savedTabsRef.current.filter(
            (savedTab) => savedTabKey(savedTab) !== key,
          );
          savedTabsRef.current = nextSavedTabs;
          await saveSavedTabs(nextSavedTabs);

          const nextOrder = tabOrderRef.current.filter((tabKey) => tabKey !== key);
          tabOrderRef.current = nextOrder;
          await saveTabOrder(nextOrder);

          const nextWindows = windowsRef.current.filter((window) => windowKey(window) !== key);
          windowsRef.current = nextWindows;
          setWindows(nextWindows);
          const nextActiveIndex = nextWindows.length === 0
            ? 0
            : Math.min(activeIndexRef.current, nextWindows.length - 1);
          activeIndexRef.current = nextActiveIndex;
          setActiveIndex(nextActiveIndex);
          setTimeout(() => refreshWindowsRef.current(), 500);
        } catch (error) {
          console.error("Failed to close or remove tab:", error);
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

    const newOrder = mergeReorderedTabsWithUnresolvedLegacyKeys(
      tabOrderRef.current,
      newWindows,
    );
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

  // Reorder using visual order: accepts array of original indices in desired visual order
  const handleReorderByVisual = useCallback((visualOrder: number[]) => {
    const currentWindows = windowsRef.current;
    const newWindows = visualOrder.map((i) => currentWindows[i]);

    const newOrder = mergeReorderedTabsWithUnresolvedLegacyKeys(
      tabOrderRef.current,
      newWindows,
    );
    tabOrderRef.current = newOrder;
    saveTabOrder(newOrder);

    // Find new active index
    const activeWindow = currentWindows[activeIndexRef.current];
    const newActiveIndex = activeWindow
      ? newWindows.findIndex((w) => runtimeWindowKey(w) === runtimeWindowKey(activeWindow))
      : 0;

    setWindows(newWindows);
    setActiveIndex(Math.max(newActiveIndex, 0));
  }, []);

  const handleColorChange = useCallback((key: string, colorId: string | null) => {
    setTabColors((prev) => {
      const next = { ...prev };
      if (colorId === null) {
        next[key] = null;
      } else {
        next[key] = colorId;
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

  const assignTabsToGroup = useCallback((wKeys: string[], groupId: string) => {
    setGroupAssignments((prev) => {
      const next = { ...prev };
      for (const wKey of wKeys) next[wKey] = groupId;
      saveGroupAssignments(next);
      return next;
    });
  }, []);

  const unassignTabsFromGroup = useCallback((wKeys: string[]) => {
    setGroupAssignments((prev) => {
      const next = { ...prev };
      for (const wKey of wKeys) next[wKey] = null;
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
      await ensureStateLoaded();
      const payload = await invoke<WindowsSnapshot | EditorWindow[]>("get_windows_snapshot");
      const snapshot = normalizeSnapshot(payload);
      void invoke("request_windows_refresh");
      if (isAppliedStructuredSnapshot(payload, lastSnapshotRevisionRef.current)) {
        return windowsRef.current.length;
      }
      const result = snapshot.windows;
      lastSnapshotRevisionRef.current = Math.max(
        lastSnapshotRevisionRef.current,
        snapshot.revision,
      );
      const sorted = applySnapshot(snapshot);

      if (result.length > 0) {
        addToHistory(result);
      }

      return sorted.length;
    } catch (error) {
      console.error("Failed to fetch windows:", error);
      return 0;
    }
  }, [addToHistory, applySnapshot, ensureStateLoaded]);

  // Refs for callback functions to avoid stale closures in event listeners
  const refreshWindowsRef = useRef(refreshWindows);
  const handleTabClickRef = useRef(handleTabClick);
  const handleCloseTabRef = useRef(handleCloseTab);
  const handleNewTabRef = useRef(handleNewTab);
  const syncActiveTabRef = useRef(syncActiveTab);
  const fetchWindowsRef = useRef(fetchWindows);

  useEffect(() => {
    refreshWindowsRef.current = refreshWindows;
  }, [refreshWindows]);
  useEffect(() => {
    handleTabClickRef.current = handleTabClick;
  }, [handleTabClick]);
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
          if (win?.is_open !== false) {
            invoke("close_editor_window", { bundle_id: win.bundle_id, window_id: win.id });
            setTimeout(() => refreshWindowsRef.current(), 500);
          }
        }
      });
      cleanupFns.push(unlistenClose);

      const unlistenSwitch = await listen<number>("switch-to-tab", (event) => {
        if (isMounted && event.payload < windowsRef.current.length) {
          handleTabClickRef.current(event.payload);
          syncWaitingTimer();
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

      const unlistenSnapshot = await listen<WindowsSnapshot>("windows:snapshot", (event) => {
        if (!isMounted) return;

        if (!orderLoadedRef.current) {
          // Initial load hasn't run yet — let fetchWindows handle first paint
          // so colors/groups/etc. load atomically with the window list.
          return;
        }

        if (event.payload.revision <= lastSnapshotRevisionRef.current) {
          return;
        }
        lastSnapshotRevisionRef.current = event.payload.revision;

        const sorted = applySnapshot(event.payload);

        // Map active_id (CGWindowID) → activeIndex in the sorted list.
        // Runs even when windows didn't change: Registry also emits on active change.
        const { active_id } = event.payload;
        if (active_id !== null && active_id !== undefined) {
          const idx = sorted.findIndex((w) => w.is_open !== false && w.id === active_id);
          if (idx >= 0 && idx !== activeIndexRef.current) {
            setActiveIndex(idx);
            activeIndexRef.current = idx;
            syncWaitingTimer();
          }
        }
      });
      cleanupFns.push(unlistenSnapshot);
    };

    setupListeners();

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
    };
  }, [applySnapshot, syncWaitingTimer, isEditorActiveRef, isTabManagerActiveRef, isVisibleRef]);

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
    handleOpenProject,
    handleOpenSavedTab,
    handleCloseTab,
    handleReorder,
    handleReorderByVisual,
    handleColorChange,
    addGroup,
    updateGroup,
    deleteGroup,
    assignTabsToGroup,
    unassignTabsFromGroup,
    toggleGroupCollapse,
    reorderGroups,
    setGroupColor,
  };
}
