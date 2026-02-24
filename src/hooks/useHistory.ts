import { useEffect, useState, useCallback, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EDITOR_DISPLAY_NAMES, MAX_HISTORY_ENTRIES } from "../types/editor";
import type { EditorWindow, HistoryEntry } from "../types/editor";
import { loadHistory, saveHistory } from "../utils/store";

interface UseHistoryParams {
  refreshWindowsRef: MutableRefObject<() => Promise<void>>;
}

interface UseHistoryReturn {
  history: HistoryEntry[];
  historyRef: MutableRefObject<HistoryEntry[]>;
  showAddMenu: boolean;
  showAddMenuRef: MutableRefObject<boolean>;
  setShowAddMenu: (show: boolean) => void;
  addToHistory: (disappeared: EditorWindow[]) => void;
  handleOpenFromHistory: (entry: HistoryEntry) => Promise<void>;
  handleClearHistory: () => void;
}

export function useHistory({ refreshWindowsRef }: UseHistoryParams): UseHistoryReturn {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const historyRef = useRef<HistoryEntry[]>([]);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const showAddMenuRef = useRef(false);

  // Keep refs in sync
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    showAddMenuRef.current = showAddMenu;
  }, [showAddMenu]);

  // Load history from store on startup
  useEffect(() => {
    loadHistory().then((entries) => {
      setHistory(entries);
      historyRef.current = entries;
    });
  }, []);

  const addToHistory = useCallback((disappeared: EditorWindow[]) => {
    const now = Date.now();

    setHistory((prev) => {
      let updated = [...prev];

      for (const win of disappeared) {
        if (!win.path) continue;

        const bundleId = win.bundle_id;
        const editorName = EDITOR_DISPLAY_NAMES[bundleId] || win.editor_name || bundleId;

        updated = updated.filter(
          (e) => !(e.name === win.name && e.bundleId === bundleId)
        );

        updated.unshift({
          name: win.name,
          path: win.path,
          bundleId,
          editorName,
          timestamp: now,
        });
      }

      if (updated.length > MAX_HISTORY_ENTRIES) {
        updated = updated.slice(0, MAX_HISTORY_ENTRIES);
      }

      historyRef.current = updated;
      saveHistory(updated);
      return updated;
    });
  }, []);

  const handleOpenFromHistory = useCallback(
    async (entry: HistoryEntry) => {
      try {
        await invoke("open_project_in_editor", {
          bundle_id: entry.bundleId,
          path: entry.path,
        });
        setTimeout(() => refreshWindowsRef.current(), 1500);
      } catch (error) {
        console.error("Failed to open project from history:", error);
      }
    },
    [refreshWindowsRef]
  );

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    historyRef.current = [];
    saveHistory([]);
  }, []);

  return {
    history,
    historyRef,
    showAddMenu,
    showAddMenuRef,
    setShowAddMenu,
    addToHistory,
    handleOpenFromHistory,
    handleClearHistory,
  };
}
