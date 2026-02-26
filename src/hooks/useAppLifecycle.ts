import { useEffect, useState, useCallback, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition, PhysicalPosition } from "@tauri-apps/api/window";
import { currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useTranslation } from "react-i18next";
import { TAB_BAR_HEIGHT, ALL_EDITOR_BUNDLE_IDS } from "../types/editor";
import type { AppActivationPayload } from "../types/editor";
import { getStore } from "../utils/store";

interface UseAppLifecycleParams {
  fetchWindowsRef: MutableRefObject<() => Promise<number>>;
  syncActiveTabRef: MutableRefObject<() => Promise<void>>;
  showAddMenuRef: MutableRefObject<boolean>;
  setShowAddMenu: (show: boolean) => void;
  isVisibleRef: MutableRefObject<boolean>;
  isEditorActiveRef: MutableRefObject<boolean>;
  isTabManagerActiveRef: MutableRefObject<boolean>;
  currentBundleIdRef: MutableRefObject<string | null>;
  notificationEnabledRef: MutableRefObject<boolean>;
}

interface UseAppLifecycleReturn {
  hasAccessibilityPermission: boolean | null;
  onboardingCompleted: boolean | null;
  handlePermissionGranted: () => void;
  handleOnboardingComplete: (dontShowAgain: boolean) => Promise<void>;
  showSettings: boolean;
  handleSettingsClose: () => Promise<void>;
  notificationEnabled: boolean;
  handleNotificationToggle: (enabled: boolean) => Promise<void>;
  autostartEnabled: boolean;
  handleAutostartToggle: (enabled: boolean) => Promise<void>;
  showBranch: boolean;
  handleShowBranchToggle: (enabled: boolean) => Promise<void>;
  resizeTabBar: () => Promise<void>;
  handleColorPickerOpen: () => Promise<void>;
  handleColorPickerClose: () => Promise<void>;
  handleAddMenuOpen: () => Promise<void>;
  handleAddMenuClose: () => Promise<void>;
}

export function useAppLifecycle({
  fetchWindowsRef,
  syncActiveTabRef,
  showAddMenuRef,
  setShowAddMenu,
  isVisibleRef,
  isEditorActiveRef,
  isTabManagerActiveRef,
  currentBundleIdRef,
  notificationEnabledRef,
}: UseAppLifecycleParams): UseAppLifecycleReturn {
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);
  const [hasAccessibilityPermission, setHasAccessibilityPermission] = useState<boolean | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [showBranch, setShowBranch] = useState(true);
  const showSettingsRef = useRef(false);
  const isInitializedRef = useRef(false);

  // Keep ref in sync
  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  // Load notification + showBranch settings from store
  useEffect(() => {
    const init = async () => {
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

      try {
        const store = await getStore();
        const savedBranch = await store.get<boolean>("settings:showBranch");
        if (savedBranch !== null && savedBranch !== undefined) {
          setShowBranch(savedBranch);
        }
      } catch {
        // default: enabled
      }
    };
    init();
  }, []);

  // Initialize autostart state
  useEffect(() => {
    isEnabled().then(setAutostartEnabled).catch(() => {});
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
          const keys = await store.keys();
          const orderKeys = keys.filter((k) => k.startsWith("order:") && k !== "order:unified");
          if (orderKeys.length > 0) {
            const merged: string[] = [];
            for (const key of orderKeys) {
              const order = await store.get<string[]>(key);
              if (order) {
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

        let hasOrderKeys = false;
        try {
          const keys = await store.keys();
          hasOrderKeys = keys.some((key) => key.startsWith("order:"));
        } catch (e) {
          console.error("Failed to get store keys:", e);
        }

        if (hasOrderKeys) {
          setOnboardingCompleted(true);
          return;
        }

        setOnboardingCompleted(false);
      } catch (error) {
        console.error("Failed to check onboarding status:", error);
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
        try {
          const monitor = (await currentMonitor()) ?? (await primaryMonitor());
          if (!monitor) {
            console.error("No monitor found for onboarding window");
            return;
          }
          const screenWidth = monitor.size.width / monitor.scaleFactor;
          const screenHeight = monitor.size.height / monitor.scaleFactor;
          await appWindow.setMaxSize(new LogicalSize(screenWidth, screenHeight));
          await appWindow.setSize(new LogicalSize(600, 500));
          await appWindow.setPosition(
            new LogicalPosition((screenWidth - 600) / 2, (screenHeight - 500) / 2)
          );
          await appWindow.show();
        } catch (error) {
          console.error("Failed to adjust window size for onboarding:", error);
        }
      } else if (!hasAccessibilityPermission) {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const screenWidth = monitor.size.width / monitor.scaleFactor;
        const screenHeight = monitor.size.height / monitor.scaleFactor;
        await appWindow.setMaxSize(new LogicalSize(screenWidth, screenHeight));
        await appWindow.setSize(new LogicalSize(600, 400));
        await appWindow.setPosition(
          new LogicalPosition((screenWidth - 600) / 2, (screenHeight - 400) / 2)
        );
      } else {
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

  const handleShowBranchToggle = useCallback(async (enabled: boolean) => {
    setShowBranch(enabled);
    try {
      const store = await getStore();
      await store.set("settings:showBranch", enabled);
    } catch (error) {
      console.error("Failed to save showBranch setting:", error);
    }
  }, []);

  const handleNotificationToggle = useCallback(
    async (enabled: boolean) => {
      setNotificationEnabled(enabled);
      notificationEnabledRef.current = enabled;
      try {
        const store = await getStore();
        await store.set("notification:enabled", enabled);
      } catch (error) {
        console.error("Failed to save notification setting:", error);
      }
    },
    [notificationEnabledRef]
  );

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
  }, [setShowAddMenu]);

  const handleAddMenuClose = useCallback(
    async () => {
      setShowAddMenu(false);
      await resizeTabBar();
    },
    [resizeTabBar, setShowAddMenu]
  );

  const handleSettingsClose = useCallback(async () => {
    setShowSettings(false);
    await resizeTabBar();
  }, [resizeTabBar]);

  // Event-driven visibility (no polling)
  useEffect(() => {
    if (hasAccessibilityPermission !== true || onboardingCompleted !== true) {
      return;
    }

    const appWindow = getCurrentWindow();
    let isMounted = true;
    const cleanupFns: (() => void)[] = [];

    const initWindow = async () => {
      await resizeTabBar();
      await appWindow.show();
      isVisibleRef.current = true;
      isInitializedRef.current = true;
      await syncActiveTabRef.current();
    };
    initWindow();

    const setupAppActivationListener = async () => {
      const unlisten = await listen<AppActivationPayload>("app-activated", async (event) => {
        if (!isMounted) return;

        const { app_type, bundle_id, is_on_primary_screen } = event.payload;

        if (app_type === "editor" || app_type === "tab_manager") {
          isEditorActiveRef.current = app_type === "editor";
          isTabManagerActiveRef.current = app_type === "tab_manager";
          if (app_type === "editor" && bundle_id) {
            currentBundleIdRef.current = bundle_id;
          }
          if (app_type === "editor") {
            // Approach 5: Wait 150ms for macOS window animation to complete
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          // Approach 4: Position-based visibility (avoid unreliable hide/show)
          await appWindow.setPosition(new PhysicalPosition(0, 0));
          isVisibleRef.current = true;
          if (app_type === "editor") {
            const windowCount = await fetchWindowsRef.current();
            setTimeout(() => syncActiveTabRef.current(), 50);
            for (const bid of ALL_EDITOR_BUNDLE_IDS) {
              invoke("apply_window_offset", { bundle_id: bid, offset_y: TAB_BAR_HEIGHT }).catch(
                () => {}
              );
            }
            // Cold start: editor may not have windows yet, retry periodically
            if (windowCount === 0) {
              for (let i = 0; i < 8; i++) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                if (!isMounted || !isEditorActiveRef.current) break;
                const count = await fetchWindowsRef.current();
                if (count > 0) {
                  setTimeout(() => syncActiveTabRef.current(), 50);
                  break;
                }
              }
            }
          }
        } else {
          isEditorActiveRef.current = false;
          isTabManagerActiveRef.current = false;

          if (is_on_primary_screen) {
            for (const bid of ALL_EDITOR_BUNDLE_IDS) {
              invoke("restore_window_positions", { bundle_id: bid }).catch(() => {});
            }
            if (isVisibleRef.current) {
              // Approach 4: Move off-screen instead of hide()
              await appWindow.setPosition(new PhysicalPosition(0, -10000));
              isVisibleRef.current = false;
            }
          }
        }
      });
      cleanupFns.push(unlisten);
    };
    setupAppActivationListener();

    const setupShowSettingsListener = async () => {
      const unlisten = await listen("show-settings", async () => {
        const monitor = await currentMonitor();
        if (monitor) {
          const screenWidth = monitor.size.width / monitor.scaleFactor;
          const screenHeight = monitor.size.height / monitor.scaleFactor;
          await appWindow.setMaxSize(new LogicalSize(screenWidth, screenHeight));
          await appWindow.setSize(new LogicalSize(600, 600));
          await appWindow.setPosition(
            new LogicalPosition((screenWidth - 600) / 2, (screenHeight - 600) / 2)
          );
        }
        await appWindow.show();
        setShowSettings(true);
      });
      cleanupFns.push(unlisten);
    };
    setupShowSettingsListener();

    const setupDisplayChangedListener = async () => {
      const unlisten = await listen("display-changed", async () => {
        if (!isMounted) return;
        if (showSettingsRef.current || showAddMenuRef.current) return;
        await resizeTabBar();
      });
      cleanupFns.push(unlisten);
    };
    setupDisplayChangedListener();

    return () => {
      isMounted = false;
      cleanupFns.forEach((fn) => fn());
    };
  }, [
    resizeTabBar,
    hasAccessibilityPermission,
    onboardingCompleted,
    fetchWindowsRef,
    syncActiveTabRef,
    showAddMenuRef,
    isVisibleRef,
    isEditorActiveRef,
    isTabManagerActiveRef,
    currentBundleIdRef,
  ]);

  return {
    hasAccessibilityPermission,
    onboardingCompleted,
    handlePermissionGranted,
    handleOnboardingComplete,
    showSettings,
    handleSettingsClose,
    notificationEnabled,
    handleNotificationToggle,
    autostartEnabled,
    handleAutostartToggle,
    showBranch,
    handleShowBranchToggle,
    resizeTabBar,
    handleColorPickerOpen,
    handleColorPickerClose,
    handleAddMenuOpen,
    handleAddMenuClose,
  };
}
