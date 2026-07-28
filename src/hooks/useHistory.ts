import { useEffect, useState, useCallback, useRef, type MutableRefObject } from "react";
import { MAX_HISTORY_ENTRIES } from "../types/editor";
import type { EditorWindow, HistoryEntry } from "../types/editor";
import {
  loadHistory,
  normalizeProjectPath,
  saveHistory,
} from "../utils/store";

interface UseHistoryReturn {
  history: HistoryEntry[];
  historyRef: MutableRefObject<HistoryEntry[]>;
  showAddMenu: boolean;
  showAddMenuRef: MutableRefObject<boolean>;
  setShowAddMenu: (show: boolean) => void;
  addToHistory: (disappeared: EditorWindow[]) => void;
  handleClearHistory: () => void;
}

function migrateHistory(entries: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const path = normalizeProjectPath(entry.path);
    if (seen.has(path)) return [];
    seen.add(path);
    return [{
      name: entry.name,
      path,
      timestamp: entry.timestamp,
    }];
  });
}

export function useHistory(): UseHistoryReturn {
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
      const migrated = migrateHistory(entries);
      setHistory(migrated);
      historyRef.current = migrated;
      if (
        migrated.length !== entries.length ||
        entries.some((entry, index) =>
          Boolean(entry.bundleId) ||
          Boolean(entry.editorName) ||
          entry.path !== migrated[index]?.path
        )
      ) {
        saveHistory(migrated);
      }
    });
  }, []);

  const addToHistory = useCallback((disappeared: EditorWindow[]) => {
    const now = Date.now();

    setHistory((prev) => {
      let updated = [...prev];

      for (const win of disappeared) {
        if (!win.path) continue;

        updated = updated.filter(
          (entry) => normalizeProjectPath(entry.path) !== normalizeProjectPath(win.path)
        );

        updated.unshift({
          name: win.name,
          path: win.path,
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
    handleClearHistory,
  };
}
