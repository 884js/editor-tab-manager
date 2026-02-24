import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Store } from "@tauri-apps/plugin-store";
import { useTranslation } from "react-i18next";
import i18n from "./i18n";
import TabBar from "./components/TabBar";
import Settings from "./components/Settings";
import AccessibilityGuide from "./components/AccessibilityGuide";
import Onboarding from "./components/Onboarding";

// タブバーの高さ（px）
const TAB_BAR_HEIGHT = 36;

export interface EditorWindow {
  id: number;
  name: string;
  path: string;
  branch?: string;
  bundle_id: string;
  editor_name: string;
}

export interface HistoryEntry {
  name: string;       // Project name
  path: string;       // File system path
  bundleId: string;   // Editor bundle ID
  editorName: string; // Editor display name
  timestamp: number;  // Date.now()
}

const EDITOR_DISPLAY_NAMES: Record<string, string> = {
  "com.microsoft.VSCode": "VSCode",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "dev.zed.Zed": "Zed",
};

const ALL_EDITOR_BUNDLE_IDS = Object.keys(EDITOR_DISPLAY_NAMES);

const MAX_HISTORY_ENTRIES = 20;

interface EditorState {
  is_active: boolean;
  windows: EditorWindow[];
  active_index: number | null;  // Index of the frontmost window
}

// Store instance (lazily initialized)
let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load("tab-order.json").catch((e) => {
      storePromise = null; // リセットしてリトライ可能に
      throw e;
    });
  }
  return storePromise;
}

const UNIFIED_ORDER_KEY = "order:unified";
const UNIFIED_COLOR_KEY = "tabColor:unified";

// Load tab order from Store
async function loadTabOrder(): Promise<string[]> {
  try {
    const store = await getStore();
    return (await store.get<string[]>(UNIFIED_ORDER_KEY)) || [];
  } catch {
    return [];
  }
}

// Save tab order to Store
async function saveTabOrder(order: string[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set(UNIFIED_ORDER_KEY, order);
  } catch (error) {
    console.error("Failed to save tab order:", error);
  }
}

// Load tab colors from Store
async function loadTabColors(): Promise<Record<string, string>> {
  try {
    const store = await getStore();
    return (await store.get<Record<string, string>>(UNIFIED_COLOR_KEY)) || {};
  } catch {
    return {};
  }
}

// Save tab colors to Store
async function saveTabColors(colors: Record<string, string>): Promise<void> {
  try {
    const store = await getStore();
    await store.set(UNIFIED_COLOR_KEY, colors);
  } catch (error) {
    console.error("Failed to save tab colors:", error);
  }
}

// Load history from Store
async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const store = await getStore();
    return (await store.get<HistoryEntry[]>("history")) || [];
  } catch {
    return [];
  }
}

// Save history to Store
async function saveHistory(entries: HistoryEntry[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set("history", entries);
  } catch (error) {
    console.error("Failed to save history:", error);
  }
}

// Unique key for a window in the unified tab bar (handles same project name in different editors)
function windowKey(w: EditorWindow): string {
  return `${w.bundle_id}:${w.name}`;
}

// Sort windows by custom order, new windows go to the end
function sortWindowsByOrder(windows: EditorWindow[], order: string[]): EditorWindow[] {
  const orderMap = new Map(order.map((key, index) => [key, index]));
  return [...windows].sort((a, b) => {
    const indexA = orderMap.get(windowKey(a)) ?? Infinity;
    const indexB = orderMap.get(windowKey(b)) ?? Infinity;
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
  is_on_primary_screen: boolean;
}

// Claude Code の状態
export type ClaudeStatus = "waiting" | "generating";

// Payload from claude-status event
interface ClaudeStatusPayload {
  statuses: Record<string, ClaudeStatus>;
}

function App() {
  const { t } = useTranslation();
  const [windows, setWindows] = useState<EditorWindow[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [claudeStatuses, setClaudeStatuses] = useState<Record<string, ClaudeStatus>>({});
  const claudeStatusesRef = useRef<Record<string, ClaudeStatus>>({});
  const [tabColors, setTabColors] = useState<Record<string, string>>({});
  const dismissedWaitingRef = useRef<Set<string>>(new Set());
  const waitingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [hasAccessibilityPermission, setHasAccessibilityPermission] = useState<boolean | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  const windowsRef = useRef<EditorWindow[]>([]);
  const activeIndexRef = useRef<number>(0);
  const isVisibleRef = useRef(true);
  const isInitializedRef = useRef(false);
  const tabOrderRef = useRef<string[]>([]);
  const isEditorActiveRef = useRef(false); // Track if editor (VSCode/Cursor) is currently active
  const isTabManagerActiveRef = useRef(false); // Track if tab_manager itself is currently active
  const showSettingsRef = useRef(false); // Track if settings panel is open (for display-changed handler)
  const currentBundleIdRef = useRef<string | null>(null); // Current editor's bundle ID
  const orderLoadedRef = useRef(false); // Track if order has been loaded from store
  const lastTabClickTimeRef = useRef<number>(0); // Track when tab was last clicked (for debounce)

  // アクティブタブの waiting バッジ用タイマーを同期する
  // アクティブタブ以外のタイマーはすべてキャンセルし、
  // アクティブタブに waiting があれば15秒タイマーを開始
  const syncWaitingTimerRef = useRef(() => {});
  syncWaitingTimerRef.current = () => {
    // 既存タイマーをすべてキャンセル
    for (const timerId of waitingTimersRef.current.values()) {
      clearTimeout(timerId);
    }
    waitingTimersRef.current.clear();

    // アクティブタブの waiting パスを探す
    const activeWindow = windowsRef.current[activeIndexRef.current];
    if (!activeWindow) return;

    for (const [path, status] of Object.entries(claudeStatusesRef.current)) {
      if (
        status === "waiting" &&
        !dismissedWaitingRef.current.has(path) &&
        path.split("/").pop() === activeWindow.name
      ) {
        const timerId = setTimeout(() => {
          waitingTimersRef.current.delete(path);
          if (claudeStatusesRef.current[path] === "waiting") {
            dismissedWaitingRef.current.add(path);
            setClaudeStatuses((prev) => {
              const next = { ...prev };
              delete next[path];
              return next;
            });
          }
        }, 15_000);
        waitingTimersRef.current.set(path, timerId);
        break; // 1プロジェクト1パス
      }
    }
  };

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const historyRef = useRef<HistoryEntry[]>([]);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const showAddMenuRef = useRef(false);

  const [notificationEnabled, setNotificationEnabled] = useState<boolean>(true);
  const notificationEnabledRef = useRef<boolean>(true);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean>(false);
  const [showBranch, setShowBranch] = useState<boolean>(true);

  // Initialize notification permission and load setting from store
  useEffect(() => {
    const initNotification = async () => {
      // Load setting from store
      try {
        const store = await getStore();
        const saved = await store.get<boolean>("notification:enabled");
        if (saved !== null && saved !== undefined) {
          setNotificationEnabled(saved);
          notificationEnabledRef.current = saved;
        }
      } catch {
        // default: enabled
      }

      // Load showBranch setting from store
      try {
        const store = await getStore();
        const savedBranch = await store.get<boolean>("settings:showBranch");
        if (savedBranch !== null && savedBranch !== undefined) {
          setShowBranch(savedBranch);
        }
      } catch {
        // default: enabled
      }

      // Request notification permission if not granted
      let granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        granted = permission === "granted";
      }
    };
    initNotification();

    // Listen for notification click → focus corresponding editor window
    let unlistenClick: (() => void) | null = null;
    listen<{ project_path: string }>("notification-clicked", async (event) => {
      const projectPath = event.payload.project_path;
      if (!projectPath) return;
      const projectName = projectPath.split("/").pop() || projectPath;

      // 1. タブバーを即座に表示
      const appWindow = getCurrentWindow();
      await appWindow.show();
      isVisibleRef.current = true;

      // 通知クリック = 確認済みなので waiting バッジを消す
      if (claudeStatusesRef.current[projectPath] === "waiting") {
        dismissedWaitingRef.current.add(projectPath);
        setClaudeStatuses(prev => {
          const next = { ...prev };
          delete next[projectPath];
          return next;
        });
        const timer = waitingTimersRef.current.get(projectPath);
        if (timer) {
          clearTimeout(timer);
          waitingTimersRef.current.delete(projectPath);
        }
      }

      // 2. macOSの通知クリックによるアプリアクティベーション完了を待つ
      await new Promise(r => setTimeout(r, 500));

      // 3. マッチするウィンドウがあればフォーカス（各ウィンドウのbundle_idを使用）
      const win = windowsRef.current.find(w => w.name === projectName);
      if (win) {
        await invoke("focus_editor_window", { bundle_id: win.bundle_id, window_id: win.id });
      } else if (windowsRef.current.length > 0) {
        const first = windowsRef.current[0];
        await invoke("focus_editor_window", { bundle_id: first.bundle_id, window_id: first.id });
      }
    }).then(u => { unlistenClick = u; });

    return () => {
      unlistenClick?.();
    };
  }, []);

  // Load history from store on startup
  useEffect(() => {
    loadHistory().then((entries) => {
      setHistory(entries);
      historyRef.current = entries;
    });
  }, []);

  // Initialize autostart state
  useEffect(() => {
    isEnabled().then(setAutostartEnabled).catch(() => {});
  }, []);

  // Autostart toggle handler
  const handleAutostartToggle = useCallback(async (enabled: boolean) => {
    try {
      if (enabled) {
        await enable();
      } else {
        await disable();
      }
      setAutostartEnabled(enabled);
    } catch (error) {
      console.error("Failed to toggle autostart:", error);
    }
  }, []);

  // Show branch toggle handler
  const handleShowBranchToggle = useCallback(async (enabled: boolean) => {
    setShowBranch(enabled);
    try {
      const store = await getStore();
      await store.set("settings:showBranch", enabled);
    } catch (error) {
      console.error("Failed to save showBranch setting:", error);
    }
  }, []);

  // Notification toggle handler
  const handleNotificationToggle = useCallback(async (enabled: boolean) => {
    setNotificationEnabled(enabled);
    notificationEnabledRef.current = enabled;
    try {
      const store = await getStore();
      await store.set("notification:enabled", enabled);
    } catch (error) {
      console.error("Failed to save notification setting:", error);
    }
  }, []);

  // Update tray menu when language changes
  useEffect(() => {
    invoke("update_tray_menu", {
      settings_label: t("tray.settings"),
      quit_label: t("tray.quit"),
    }).catch((error) => {
      console.error("Failed to update tray menu:", error);
    });
  }, [t]);

  // Check accessibility permission and onboarding status on startup
  useEffect(() => {
    const init = async () => {
      // Check accessibility permission
      let hasPermission = true;
      try {
        hasPermission = await invoke<boolean>("check_accessibility_permission");
      } catch (error) {
        console.error("Failed to check accessibility permission:", error);
      }
      setHasAccessibilityPermission(hasPermission);

      // Migrate from per-editor store keys to unified keys
      try {
        const store = await getStore();
        const hasUnifiedOrder = await store.get<string[]>("order:unified");
        if (!hasUnifiedOrder) {
          // Merge all existing per-editor order keys into unified
          const keys = await store.keys();
          const orderKeys = keys.filter((k) => k.startsWith("order:") && k !== "order:unified");
          if (orderKeys.length > 0) {
            const merged: string[] = [];
            for (const key of orderKeys) {
              const order = await store.get<string[]>(key);
              if (order) {
                // Old keys used plain names; add bundle_id prefix based on key
                const bundleId = key.replace("order:", "");
                for (const name of order) {
                  const newKey = `${bundleId}:${name}`;
                  if (!merged.includes(newKey)) {
                    merged.push(newKey);
                  }
                }
              }
            }
            if (merged.length > 0) {
              await store.set("order:unified", merged);
            }
          }
          // Merge tab colors similarly
          const colorKeys = keys.filter((k) => k.startsWith("tabColor:") && k !== "tabColor:unified");
          if (colorKeys.length > 0) {
            const mergedColors: Record<string, string> = {};
            for (const key of colorKeys) {
              const colors = await store.get<Record<string, string>>(key);
              if (colors) {
                Object.assign(mergedColors, colors);
              }
            }
            if (Object.keys(mergedColors).length > 0) {
              await store.set("tabColor:unified", mergedColors);
            }
          }
          // Remove old per-editor keys to prevent re-migration
          for (const key of [...orderKeys, ...colorKeys]) {
            await store.delete(key);
          }
          await store.save();
        }
      } catch (error) {
        console.error("Failed to migrate store keys:", error);
      }

      // Check onboarding status
      try {
        const store = await getStore();
        const completed = await store.get<boolean>("onboarding:completed");
        if (completed) {
          setOnboardingCompleted(true);
          return;
        }

        // Check if existing user (has order:* keys)
        let hasOrderKeys = false;
        try {
          const keys = await store.keys();
          hasOrderKeys = keys.some((key) => key.startsWith("order:"));
        } catch (e) {
          console.error("Failed to get store keys:", e);
          // keys()失敗時は既存ユーザーではないとみなす → オンボーディング表示
        }

        if (hasOrderKeys) {
          // Existing user - skip onboarding
          setOnboardingCompleted(true);
          return;
        }

        setOnboardingCompleted(false);
      } catch (error) {
        console.error("Failed to check onboarding status:", error);
        // On error, show onboarding (user can dismiss it; next launch will retry)
        setOnboardingCompleted(false);
      }
    };
    init();
  }, []);

  const handlePermissionGranted = useCallback(() => {
    setHasAccessibilityPermission(true);
  }, []);

  const handleOnboardingComplete = useCallback(async (dontShowAgain: boolean) => {
    if (dontShowAgain) {
      try {
        const store = await getStore();
        await store.set("onboarding:completed", true);
        await store.save();
      } catch (error) {
        console.error("Failed to save onboarding status:", error);
      }
    }
    setOnboardingCompleted(true);
    // Re-check accessibility permission
    try {
      const hasPermission = await invoke<boolean>("check_accessibility_permission");
      setHasAccessibilityPermission(hasPermission);
    } catch {
      // ignore
    }
  }, []);

  // Adjust window size based on onboarding/accessibility state
  useEffect(() => {
    if (hasAccessibilityPermission === null || onboardingCompleted === null) return;

    const adjustWindowSize = async () => {
      const appWindow = getCurrentWindow();

      if (!onboardingCompleted) {
        // Onboarding用: 600x500のウィンドウ
        try {
          const monitor = await currentMonitor() ?? await primaryMonitor();
          if (!monitor) {
            console.error("No monitor found for onboarding window");
            return;
          }
          const screenWidth = monitor.size.width / monitor.scaleFactor;
          const screenHeight = monitor.size.height / monitor.scaleFactor;
          await appWindow.setMaxSize(new LogicalSize(screenWidth, screenHeight));
          await appWindow.setSize(new LogicalSize(600, 500));
          await appWindow.setPosition(new LogicalPosition(
            (screenWidth - 600) / 2,
            (screenHeight - 500) / 2
          ));
          await appWindow.show();
        } catch (error) {
          console.error("Failed to adjust window size for onboarding:", error);
        }
      } else if (!hasAccessibilityPermission) {
        // AccessibilityGuide用: 大きいウィンドウ（設定画面と同様）
        const monitor = await currentMonitor();
        if (!monitor) return;
        const screenWidth = monitor.size.width / monitor.scaleFactor;
        const screenHeight = monitor.size.height / monitor.scaleFactor;
        await appWindow.setMaxSize(new LogicalSize(screenWidth, screenHeight));
        await appWindow.setSize(new LogicalSize(600, 400));
        await appWindow.setPosition(new LogicalPosition(
          (screenWidth - 600) / 2,
          (screenHeight - 400) / 2
        ));
      } else {
        // 権限許可後: タブバーサイズに戻す
        const monitor = await primaryMonitor();
        if (!monitor) return;
        const screenWidth = monitor.size.width / monitor.scaleFactor;
        await appWindow.setMaxSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
        await appWindow.setSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
        await appWindow.setPosition(new LogicalPosition(0, 0));
      }
    };

    adjustWindowSize();
  }, [hasAccessibilityPermission, onboardingCompleted]);

  // Keep refs in sync with state
  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    showAddMenuRef.current = showAddMenu;
  }, [showAddMenu]);

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const refreshWindows = useCallback(async () => {
    try {
      // Load order from store if not already loaded
      if (!orderLoadedRef.current) {
        tabOrderRef.current = await loadTabOrder();
        orderLoadedRef.current = true;
      }

      const result = await invoke<EditorWindow[]>("get_all_editor_windows");
      // Sort by custom order
      const sorted = sortWindowsByOrder(result, tabOrderRef.current);
      // Update order ref but don't save to store - only save on explicit reorder
      const newOrder = sorted.map(w => windowKey(w));
      const orderChanged = newOrder.length !== tabOrderRef.current.length ||
        newOrder.some((key, i) => tabOrderRef.current[i] !== key);
      if (orderChanged) {
        tabOrderRef.current = newOrder;
      }

      // Only update state if windows actually changed (prevents unnecessary re-renders)
      const currentWindows = windowsRef.current;
      const hasChanged = sorted.length !== currentWindows.length ||
        sorted.some((w, i) => currentWindows[i]?.name !== w.name || currentWindows[i]?.bundle_id !== w.bundle_id || currentWindows[i]?.branch !== w.branch);

      if (hasChanged) {
        // Detect disappeared windows for history
        const newKeys = new Set(sorted.map(w => windowKey(w)));
        const disappeared = currentWindows.filter(w => !newKeys.has(windowKey(w)) && w.path);
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
  }, []);

  // Sync active tab with frontmost editor window (called on window-focus-changed event)
  const syncActiveTab = useCallback(async () => {
    // タブクリック直後（200ms以内）は同期をスキップ（競合状態を防ぐ）
    const timeSinceLastClick = Date.now() - lastTabClickTimeRef.current;
    if (timeSinceLastClick < 200) {
      return;
    }

    try {
      // Get frontmost editor state (any editor)
      const state = await invoke<EditorState>("get_editor_state", { bundle_id: null });

      // Sync activeIndex with frontmost editor window
      if (state.active_index !== null && state.windows.length > 0) {
        const frontmost = state.windows[state.active_index];
        // Find this window in our unified (sorted) tab list by both name and bundle_id
        const sortedIndex = windowsRef.current.findIndex(
          w => w.name === frontmost?.name && w.bundle_id === frontmost?.bundle_id
        );
        if (sortedIndex >= 0 && sortedIndex !== activeIndexRef.current) {
          setActiveIndex(sortedIndex);
          activeIndexRef.current = sortedIndex;
          syncWaitingTimerRef.current();
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
      // waiting バッジをクリア（タブクリックで「確認済み」とする）
      const waitingKey = Object.entries(claudeStatusesRef.current).find(
        ([path, status]) => status === "waiting" && path.split("/").pop() === window.name
      )?.[0];
      if (waitingKey) {
        dismissedWaitingRef.current.add(waitingKey);
        setClaudeStatuses(prev => {
          const next = { ...prev };
          delete next[waitingKey];
          return next;
        });
        const timer = waitingTimersRef.current.get(waitingKey);
        if (timer) {
          clearTimeout(timer);
          waitingTimersRef.current.delete(waitingKey);
        }
      }

      // クリック元タブのタイマーもキャンセル（別タブに移動するため）
      for (const timerId of waitingTimersRef.current.values()) {
        clearTimeout(timerId);
      }
      waitingTimersRef.current.clear();

      // Use the window's own bundle_id for correct editor targeting
      invoke("focus_editor_window", { bundle_id: window.bundle_id, window_id: window.id })
        .then(() => invoke("maximize_editor_window", { bundle_id: window.bundle_id, window_id: window.id, tab_bar_height: TAB_BAR_HEIGHT }))
        .catch((error) => {
          console.error("Failed to focus/maximize window:", error);
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

  // Add disappeared windows to history
  const addToHistory = useCallback((disappeared: EditorWindow[]) => {
    const now = Date.now();

    setHistory((prev) => {
      let updated = [...prev];

      for (const win of disappeared) {
        if (!win.path) continue; // Skip windows without resolved path

        const bundleId = win.bundle_id;
        const editorName = EDITOR_DISPLAY_NAMES[bundleId] || win.editor_name || bundleId;

        // Remove existing entry with same name + bundleId (will re-add at front)
        updated = updated.filter(
          (e) => !(e.name === win.name && e.bundleId === bundleId)
        );

        // Add to front
        updated.unshift({
          name: win.name,
          path: win.path,
          bundleId,
          editorName,
          timestamp: now,
        });
      }

      // Limit to max entries
      if (updated.length > MAX_HISTORY_ENTRIES) {
        updated = updated.slice(0, MAX_HISTORY_ENTRIES);
      }

      historyRef.current = updated;
      saveHistory(updated);
      return updated;
    });
  }, []);

  const handleOpenFromHistory = useCallback(async (entry: HistoryEntry) => {
    try {
      await invoke("open_project_in_editor", {
        bundle_id: entry.bundleId,
        path: entry.path,
      });
      // Refresh windows after a delay to let the editor open
      setTimeout(refreshWindows, 1500);
    } catch (error) {
      console.error("Failed to open project from history:", error);
    }
  }, [refreshWindows]);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    historyRef.current = [];
    saveHistory([]);
  }, []);

  const handleCloseTab = useCallback(async (index: number) => {
    const win = windowsRef.current[index];
    if (win) {
      const ok = await ask(t("app.closeConfirm", { name: win.name || t("app.untitled") }), {
        title: t("app.closeConfirmTitle"),
        kind: "warning",
      });
      if (!ok) return;

      try {
        await invoke("close_editor_window", { bundle_id: win.bundle_id, window_id: win.id });
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
    const newOrder = newWindows.map(w => windowKey(w));
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
          syncWaitingTimerRef.current();
          const win = windowsRef.current[event.payload];
          if (win) {
            invoke("focus_editor_window", { bundle_id: win.bundle_id, window_id: win.id })
              .then(() => invoke("maximize_editor_window", { bundle_id: win.bundle_id, window_id: win.id, tab_bar_height: TAB_BAR_HEIGHT }));
          }
        }
      });
      cleanupFns.push(unlistenSwitch);

      // Listen for window-focus-changed event from AXObserver (Rust backend)
      const unlistenWindowFocus = await listen("window-focus-changed", async () => {
        if (!isMounted || !isEditorActiveRef.current) return;
        syncActiveTabRef.current();
        // Fallback: AXFocusedWindowChanged means an editor is active,
        // so show the tab bar if it's currently hidden
        if (!isVisibleRef.current) {
          const appWindow = getCurrentWindow();
          await appWindow.show();
          isVisibleRef.current = true;
        }
      });
      cleanupFns.push(unlistenWindowFocus);

      // Listen for windows-changed event (window created/destroyed)
      const unlistenWindowsChanged = await listen("windows-changed", () => {
        if (!isMounted || !isEditorActiveRef.current) return;
        refreshWindowsRef.current();
      });
      cleanupFns.push(unlistenWindowsChanged);

      // Listen for Claude Code status events
      const unlistenClaude = await listen<ClaudeStatusPayload>("claude-status", (event) => {
        if (!isMounted) return;
        const newStatuses = event.payload.statuses;
        const prev = claudeStatusesRef.current;

        // dismissed パスの更新: waiting 以外に変わったら dismissed から除外
        for (const path of dismissedWaitingRef.current) {
          if (newStatuses[path] !== "waiting") {
            dismissedWaitingRef.current.delete(path);
          }
        }

        // dismissed な waiting をフィルタ
        const filtered: Record<string, ClaudeStatus> = {};
        for (const [path, status] of Object.entries(newStatuses)) {
          if (status === "waiting" && dismissedWaitingRef.current.has(path)) {
            continue;
          }
          filtered[path] = status;
        }

        // generating → waiting の遷移を検出（= 生成完了 → デスクトップ通知）
        const completedPaths = Object.keys(filtered).filter(
          path => filtered[path] === "waiting" && prev[path] === "generating"
        );

        if (completedPaths.length > 0 && notificationEnabledRef.current && !isEditorActiveRef.current) {
          for (const path of completedPaths) {
            const projectName = path.split("/").pop() || path;
            invoke("send_notification", {
              title: projectName,
              subtitle: "Claude Code",
              body: i18n.t("app.notificationBody"),
              project_path: path,
            });
          }
        }

        // ref は常に生のバックエンド状態を保持
        claudeStatusesRef.current = newStatuses;

        // アクティブタブの waiting バッジ自動消去タイマーを同期
        syncWaitingTimerRef.current();

        // waiting → generating の遷移を検出（リセット演出）
        const resetPaths = Object.keys(filtered).filter(
          path => filtered[path] === "generating" && prev[path] === "waiting"
        );

        if (resetPaths.length > 0) {
          const interim: Record<string, ClaudeStatus> = {};
          for (const [path, status] of Object.entries(filtered)) {
            if (!resetPaths.includes(path)) {
              interim[path] = status;
            }
          }
          setClaudeStatuses(interim);

          setTimeout(() => {
            if (isMounted) {
              setClaudeStatuses(filtered);
            }
          }, 150);
        } else {
          setClaudeStatuses(filtered);
        }
      });
      cleanupFns.push(unlistenClaude);
    };

    setupListeners();

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
      for (const timerId of waitingTimersRef.current.values()) {
        clearTimeout(timerId);
      }
      waitingTimersRef.current.clear();
    };
  }, []); // Empty dependency array - listeners set up once

  // Fetch windows from all editors (unified tab bar)
  const fetchWindows = useCallback(async () => {
    try {
      // Load order and colors from store if not loaded yet
      if (!orderLoadedRef.current) {
        const [order, colors] = await Promise.all([
          loadTabOrder(),
          loadTabColors(),
        ]);
        tabOrderRef.current = order;
        setTabColors(colors);
        orderLoadedRef.current = true;
      }

      const result = await invoke<EditorWindow[]>("get_all_editor_windows");
      // Sort by custom order
      const sorted = sortWindowsByOrder(result, tabOrderRef.current);
      // Update order ref but don't save to store - only save on explicit reorder
      tabOrderRef.current = sorted.map(w => windowKey(w));

      // Update windows only if changed
      const currentWindows = windowsRef.current;
      const hasChanged = sorted.length !== currentWindows.length ||
        sorted.some((w, i) => currentWindows[i]?.name !== w.name || currentWindows[i]?.bundle_id !== w.bundle_id || currentWindows[i]?.branch !== w.branch);

      if (hasChanged) {
        setWindows(sorted);
        if (sorted.length > 0 && activeIndexRef.current >= sorted.length) {
          setActiveIndex(sorted.length - 1);
        }
      }

      // Record current windows to history (so open tabs are also in history)
      if (sorted.length > 0) {
        addToHistory(sorted);
      }
    } catch (error) {
      console.error("Failed to fetch windows:", error);
    }
  }, [addToHistory]);

  // Resize tab bar to match primary monitor width
  const resizeTabBar = useCallback(async () => {
    const appWindow = getCurrentWindow();
    const monitor = await primaryMonitor();
    if (monitor) {
      const screenWidth = monitor.size.width / monitor.scaleFactor;
      await appWindow.setMaxSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
      await appWindow.setSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT));
      await appWindow.setPosition(new LogicalPosition(0, 0));
    }
  }, []);

  const handleColorPickerOpen = useCallback(async () => {
    const appWindow = getCurrentWindow();
    const monitor = await primaryMonitor();
    if (monitor) {
      const screenWidth = monitor.size.width / monitor.scaleFactor;
      await appWindow.setMaxSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT + 50));
      await appWindow.setSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT + 50));
    }
  }, []);

  const handleColorPickerClose = useCallback(async () => {
    await resizeTabBar();
  }, [resizeTabBar]);

  const handleAddMenuOpen = useCallback(async () => {
    const appWindow = getCurrentWindow();
    const monitor = await primaryMonitor();
    if (monitor) {
      const screenWidth = monitor.size.width / monitor.scaleFactor;
      await appWindow.setMaxSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT + 420));
      await appWindow.setSize(new LogicalSize(screenWidth, TAB_BAR_HEIGHT + 420));
    }
    setShowAddMenu(true);
  }, []);

  const handleAddMenuClose = useCallback(async () => {
    setShowAddMenu(false);
    await resizeTabBar();
  }, [resizeTabBar]);

  // Event-driven visibility (no polling)
  useEffect(() => {
    // オンボーディング完了 & 権限許可されるまでは何もしない
    if (hasAccessibilityPermission !== true || onboardingCompleted !== true) {
      return;
    }

    const appWindow = getCurrentWindow();
    let isMounted = true;
    const cleanupFns: (() => void)[] = [];

    // Initialize window on startup - always start with tab bar
    const initWindow = async () => {
      await resizeTabBar();
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

        const { app_type, bundle_id, is_on_primary_screen } = event.payload;

        if (app_type === "editor" || app_type === "tab_manager") {
          // Editor or our app is active - show the tab bar
          isEditorActiveRef.current = app_type === "editor";
          isTabManagerActiveRef.current = app_type === "tab_manager";
          if (app_type === "editor" && bundle_id) {
            currentBundleIdRef.current = bundle_id;
          }
          await appWindow.show();
          isVisibleRef.current = true;
          // Fetch all editor windows (unified tab bar)
          if (app_type === "editor") {
            await fetchWindows();
            // Apply window offset to ALL editors
            for (const bid of ALL_EDITOR_BUNDLE_IDS) {
              invoke("apply_window_offset", { bundle_id: bid, offset_y: TAB_BAR_HEIGHT }).catch(() => {});
            }
          }
        } else {
          // Other app is active
          isEditorActiveRef.current = false;
          isTabManagerActiveRef.current = false;

          if (is_on_primary_screen) {
            // プライマリモニタの別アプリ → タブバーを非表示、全エディタのオフセット復元
            for (const bid of ALL_EDITOR_BUNDLE_IDS) {
              invoke("restore_window_positions", { bundle_id: bid }).catch(() => {});
            }
            if (isVisibleRef.current) {
              await appWindow.hide();
              isVisibleRef.current = false;
            }
          }
          // セカンダリモニタの場合 → 何もしない（タブバー表示・オフセット維持）
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

    // Listen for display configuration changes (monitor connect/disconnect, resolution change)
    const setupDisplayChangedListener = async () => {
      const unlisten = await listen("display-changed", async () => {
        if (!isMounted) return;
        // Settings またはメニューが開いている間はタブバーのリサイズをスキップ
        if (showSettingsRef.current || showAddMenuRef.current) return;
        // タブバーを新しいモニターサイズにリサイズ
        // (ウィンドウオフセットの再適用は observer.rs のメインスレッドで実行済み)
        await resizeTabBar();
      });
      cleanupFns.push(unlisten);
    };
    setupDisplayChangedListener();

    // No polling - all updates are event-driven via AXObserver and NSWorkspace observer

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
    };
  }, [fetchWindows, resizeTabBar, hasAccessibilityPermission, onboardingCompleted]);

  const handleSettingsClose = useCallback(async () => {
    setShowSettings(false);
    // Restore to tab bar size with maxHeight restriction
    await resizeTabBar();
  }, [resizeTabBar]);


  // Show loading state while checking permission/onboarding
  if (hasAccessibilityPermission === null || onboardingCompleted === null) {
    return null;
  }

  // Show onboarding for first-time users
  if (!onboardingCompleted) {
    return (
      <Onboarding
        onComplete={handleOnboardingComplete}
        hasAccessibilityPermission={hasAccessibilityPermission}
      />
    );
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
          claudeStatuses={claudeStatuses}
          tabColors={tabColors}
          onColorChange={handleColorChange}
          onColorPickerOpen={handleColorPickerOpen}
          onColorPickerClose={handleColorPickerClose}
          showBranch={showBranch}
          history={history}
          showAddMenu={showAddMenu}
          onAddMenuOpen={handleAddMenuOpen}
          onAddMenuClose={handleAddMenuClose}
          onHistorySelect={handleOpenFromHistory}
          onHistoryClear={handleClearHistory}
        />
      )}
      {showSettings && (
        <Settings
          onClose={handleSettingsClose}
          notificationEnabled={notificationEnabled}
          onNotificationToggle={handleNotificationToggle}
          autostartEnabled={autostartEnabled}
          onAutostartToggle={handleAutostartToggle}
          showBranchEnabled={showBranch}
          onShowBranchToggle={handleShowBranchToggle}
        />
      )}
    </>
  );
}

export default App;
