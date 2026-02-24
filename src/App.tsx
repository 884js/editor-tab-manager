import { useRef } from "react";
import { useTranslation } from "react-i18next";
import TabBar from "./components/TabBar";
import Settings from "./components/Settings";
import AccessibilityGuide from "./components/AccessibilityGuide";
import Onboarding from "./components/Onboarding";
import type { EditorWindow } from "./types/editor";
import { useClaudeStatus } from "./hooks/useClaudeStatus";
import { useHistory } from "./hooks/useHistory";
import { useEditorWindows } from "./hooks/useEditorWindows";
import { useAppLifecycle } from "./hooks/useAppLifecycle";

// Re-export for backward compatibility
export type { EditorWindow, HistoryEntry, ClaudeStatus } from "./types/editor";

function App() {
  const { t } = useTranslation();

  // Shared mutable refs owned by App, distributed to hooks
  const isVisibleRef = useRef(true);
  const isEditorActiveRef = useRef(false);
  const isTabManagerActiveRef = useRef(false);
  const currentBundleIdRef = useRef<string | null>(null);
  const notificationEnabledRef = useRef(true);

  // Bridge refs for cross-hook communication
  // These are populated by useEditorWindows on every render
  const windowsBridgeRef = useRef<EditorWindow[]>([]);
  const activeIndexBridgeRef = useRef<number>(0);
  const refreshWindowsBridgeRef = useRef<() => Promise<void>>(async () => {});
  const fetchWindowsBridgeRef = useRef<() => Promise<void>>(async () => {});
  const syncActiveTabBridgeRef = useRef<() => Promise<void>>(async () => {});

  // 1. Claude status (reads bridge refs lazily via event handlers)
  const claude = useClaudeStatus({
    windowsRef: windowsBridgeRef,
    activeIndexRef: activeIndexBridgeRef,
    isEditorActiveRef,
    isVisibleRef,
    notificationEnabledRef,
  });

  // 2. History (reads bridge ref lazily)
  const history = useHistory({
    refreshWindowsRef: refreshWindowsBridgeRef,
  });

  // 3. Editor windows
  const editorWindows = useEditorWindows({
    dismissWaitingForWindow: claude.dismissWaitingForWindow,
    syncWaitingTimer: claude.syncWaitingTimer,
    addToHistory: history.addToHistory,
    currentBundleIdRef,
    isEditorActiveRef,
    isVisibleRef,
    t,
  });

  // Sync bridge refs to actual hook values on every render
  // Event handlers read these lazily, so they always get the latest values
  windowsBridgeRef.current = editorWindows.windowsRef.current;
  activeIndexBridgeRef.current = editorWindows.activeIndexRef.current;
  refreshWindowsBridgeRef.current = editorWindows.refreshWindowsRef.current;
  fetchWindowsBridgeRef.current = editorWindows.fetchWindowsRef.current;
  syncActiveTabBridgeRef.current = editorWindows.syncActiveTabRef.current;

  // 4. App lifecycle (initialization, settings, window sizing)
  const lifecycle = useAppLifecycle({
    fetchWindowsRef: fetchWindowsBridgeRef,
    syncActiveTabRef: syncActiveTabBridgeRef,
    showAddMenuRef: history.showAddMenuRef,
    setShowAddMenu: history.setShowAddMenu,
    isVisibleRef,
    isEditorActiveRef,
    isTabManagerActiveRef,
    currentBundleIdRef,
    notificationEnabledRef,
  });

  // Show loading state while checking permission/onboarding
  if (lifecycle.hasAccessibilityPermission === null || lifecycle.onboardingCompleted === null) {
    return null;
  }

  // Show onboarding for first-time users
  if (!lifecycle.onboardingCompleted) {
    return (
      <Onboarding
        onComplete={lifecycle.handleOnboardingComplete}
        hasAccessibilityPermission={lifecycle.hasAccessibilityPermission}
      />
    );
  }

  // Show accessibility guide if permission not granted
  if (!lifecycle.hasAccessibilityPermission) {
    return <AccessibilityGuide onPermissionGranted={lifecycle.handlePermissionGranted} />;
  }

  return (
    <>
      {!lifecycle.showSettings && (
        <TabBar
          tabs={editorWindows.windows}
          activeIndex={editorWindows.activeIndex}
          onTabClick={editorWindows.handleTabClick}
          onNewTab={editorWindows.handleNewTab}
          onCloseTab={editorWindows.handleCloseTab}
          onReorder={editorWindows.handleReorder}
          claudeStatuses={claude.claudeStatuses}
          tabColors={editorWindows.tabColors}
          onColorChange={editorWindows.handleColorChange}
          onColorPickerOpen={lifecycle.handleColorPickerOpen}
          onColorPickerClose={lifecycle.handleColorPickerClose}
          showBranch={lifecycle.showBranch}
          history={history.history}
          showAddMenu={history.showAddMenu}
          onAddMenuOpen={lifecycle.handleAddMenuOpen}
          onAddMenuClose={lifecycle.handleAddMenuClose}
          onHistorySelect={history.handleOpenFromHistory}
          onHistoryClear={history.handleClearHistory}
        />
      )}
      {lifecycle.showSettings && (
        <Settings
          onClose={lifecycle.handleSettingsClose}
          notificationEnabled={lifecycle.notificationEnabled}
          onNotificationToggle={lifecycle.handleNotificationToggle}
          autostartEnabled={lifecycle.autostartEnabled}
          onAutostartToggle={lifecycle.handleAutostartToggle}
          showBranchEnabled={lifecycle.showBranch}
          onShowBranchToggle={lifecycle.handleShowBranchToggle}
        />
      )}
    </>
  );
}

export default App;
