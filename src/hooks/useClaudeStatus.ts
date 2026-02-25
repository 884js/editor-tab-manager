import { useEffect, useState, useRef, useCallback, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import i18n from "../i18n";
import type { EditorWindow, ClaudeStatus, ClaudeStatusPayload } from "../types/editor";

interface UseClaudeStatusParams {
  windowsRef: MutableRefObject<EditorWindow[]>;
  activeIndexRef: MutableRefObject<number>;
  isEditorActiveRef: MutableRefObject<boolean>;
  isVisibleRef: MutableRefObject<boolean>;
  notificationEnabledRef: MutableRefObject<boolean>;
}

interface UseClaudeStatusReturn {
  claudeStatuses: Record<string, ClaudeStatus>;
  claudeStatusesRef: MutableRefObject<Record<string, ClaudeStatus>>;
  dismissWaitingForWindow: (window: EditorWindow) => void;
  syncWaitingTimer: () => void;
  dismissedWaitingRef: MutableRefObject<Set<string>>;
  waitingTimersRef: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
}

export function useClaudeStatus({
  windowsRef,
  activeIndexRef,
  isEditorActiveRef,
  isVisibleRef,
  notificationEnabledRef,
}: UseClaudeStatusParams): UseClaudeStatusReturn {
  const [claudeStatuses, setClaudeStatuses] = useState<Record<string, ClaudeStatus>>({});
  const claudeStatusesRef = useRef<Record<string, ClaudeStatus>>({});
  const dismissedWaitingRef = useRef<Set<string>>(new Set());
  const waitingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Sync waiting timer for active tab badge auto-dismiss
  const syncWaitingTimerRef = useRef(() => {});
  syncWaitingTimerRef.current = () => {
    for (const timerId of waitingTimersRef.current.values()) {
      clearTimeout(timerId);
    }
    waitingTimersRef.current.clear();

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
        break;
      }
    }
  };

  const syncWaitingTimer = useCallback(() => {
    syncWaitingTimerRef.current();
  }, []);

  const dismissWaitingForWindow = useCallback((window: EditorWindow) => {
    const waitingKey = Object.entries(claudeStatusesRef.current).find(
      ([path, status]) => status === "waiting" && path.split("/").pop() === window.name
    )?.[0];
    if (waitingKey) {
      dismissedWaitingRef.current.add(waitingKey);
      setClaudeStatuses((prev) => {
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
    // Cancel all timers (switching tabs)
    for (const timerId of waitingTimersRef.current.values()) {
      clearTimeout(timerId);
    }
    waitingTimersRef.current.clear();
  }, []);

  // Initialize notification permission
  useEffect(() => {
    const initNotification = async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        granted = permission === "granted";
      }
    };
    initNotification();
  }, []);

  // notification-clicked listener
  useEffect(() => {
    let isMounted = true;
    let unlistenClick: (() => void) | null = null;

    const setupListener = async () => {
      const unlisten = await listen<{ project_path: string }>("notification-clicked", async (event) => {
        if (!isMounted) return;
        const projectPath = event.payload.project_path;
        if (!projectPath) return;
        const projectName = projectPath.split("/").pop() || projectPath;

        const appWindow = getCurrentWindow();
        await appWindow.show();
        isVisibleRef.current = true;

        if (claudeStatusesRef.current[projectPath] === "waiting") {
          dismissedWaitingRef.current.add(projectPath);
          setClaudeStatuses((prev) => {
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

        await new Promise((r) => setTimeout(r, 500));

        const win = windowsRef.current.find((w) => w.name === projectName);
        if (win) {
          await invoke("focus_editor_window", { bundle_id: win.bundle_id, window_id: win.id });
        } else if (windowsRef.current.length > 0) {
          const first = windowsRef.current[0];
          await invoke("focus_editor_window", { bundle_id: first.bundle_id, window_id: first.id });
        }
      });
      if (isMounted) {
        unlistenClick = unlisten;
      } else {
        unlisten();
      }
    };
    setupListener();

    return () => {
      isMounted = false;
      unlistenClick?.();
    };
  }, [windowsRef, isVisibleRef]);

  // claude-status event listener
  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | null = null;

    listen<ClaudeStatusPayload>("claude-status", (event) => {
      if (!isMounted) return;
      const newStatuses = event.payload.statuses;
      const prev = claudeStatusesRef.current;

      for (const path of dismissedWaitingRef.current) {
        if (newStatuses[path] !== "waiting") {
          dismissedWaitingRef.current.delete(path);
        }
      }

      const filtered: Record<string, ClaudeStatus> = {};
      for (const [path, status] of Object.entries(newStatuses)) {
        if (status === "waiting" && dismissedWaitingRef.current.has(path)) {
          continue;
        }
        filtered[path] = status;
      }

      const completedPaths = Object.keys(filtered).filter(
        (path) => filtered[path] === "waiting" && prev[path] === "generating"
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

      claudeStatusesRef.current = filtered;
      syncWaitingTimerRef.current();

      const resetPaths = Object.keys(filtered).filter(
        (path) => filtered[path] === "generating" && prev[path] === "waiting"
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
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      isMounted = false;
      unlisten?.();
      for (const timerId of waitingTimersRef.current.values()) {
        clearTimeout(timerId);
      }
      waitingTimersRef.current.clear();
    };
  }, [isEditorActiveRef, notificationEnabledRef]);

  return {
    claudeStatuses,
    claudeStatusesRef,
    dismissWaitingForWindow,
    syncWaitingTimer,
    dismissedWaitingRef,
    waitingTimersRef,
  };
}
