import {
  EDITOR_DISPLAY_NAMES,
  type EditorWindow,
  type HistoryEntry,
  type ProjectMetadata,
  type SavedTab,
} from "../types/editor";
import { normalizeProjectPath, runtimeWindowKey, windowKey } from "./store";

export interface ReconciledTabs {
  savedTabs: SavedTab[];
  tabs: EditorWindow[];
}

export function savedTabKey(tab: SavedTab): string {
  return `${tab.bundle_id}:${normalizeProjectPath(tab.path)}`;
}

function toSavedTab(window: EditorWindow): SavedTab {
  return {
    runtime_id: window.runtime_id,
    name: window.name,
    path: normalizeProjectPath(window.path),
    branch: window.branch,
    repository_id: window.repository_id,
    repository_name: window.repository_name,
    bundle_id: window.bundle_id,
    editor_name: window.editor_name,
    resolution: window.resolution,
  };
}

function toClosedWindow(tab: SavedTab): EditorWindow {
  const key = savedTabKey(tab);
  return {
    id: 0,
    ...tab,
    runtime_id: tab.runtime_id ?? `saved:${key}`,
    path: normalizeProjectPath(tab.path),
    is_open: false,
  };
}

export function reconcilePersistentTabs(
  savedTabs: SavedTab[],
  liveWindows: EditorWindow[],
): ReconciledTabs {
  const savedByKey = new Map<string, SavedTab>();
  for (const tab of savedTabs) {
    if (!tab.path || !tab.bundle_id) continue;
    savedByKey.set(savedTabKey(tab), {
      ...tab,
      path: normalizeProjectPath(tab.path),
    });
  }

  const liveByKey = new Map<string, EditorWindow>();
  const unresolvedWindows = liveWindows
    .filter((window) => !window.path)
    .map((window) => ({ ...window, is_open: true }));

  for (const window of liveWindows) {
    if (!window.path) continue;

    const openWindow = { ...window, is_open: true };
    const key = windowKey(window);
    liveByKey.set(key, openWindow);
    savedByKey.set(key, toSavedTab(window));
  }

  const unmatchedWindowIndices = new Set(unresolvedWindows.map((_, index) => index));
  const availableSavedTabs = () => [...savedByKey.entries()].filter(
    ([key]) => !liveByKey.has(key),
  );
  const matchWindow = (index: number, [key, savedTab]: [string, SavedTab]) => {
    const openWindow = unresolvedWindows[index];
    const matchedWindow: EditorWindow = {
      ...savedTab,
      ...openWindow,
      path: savedTab.path,
      branch: openWindow.branch ?? savedTab.branch,
      repository_id: openWindow.repository_id ?? savedTab.repository_id,
      repository_name: openWindow.repository_name ?? savedTab.repository_name,
      resolution: savedTab.resolution ??
        (openWindow.resolution === "unresolved" ? "inferred" : openWindow.resolution),
    };
    liveByKey.set(key, matchedWindow);
    savedByKey.set(key, toSavedTab(matchedWindow));
    unmatchedWindowIndices.delete(index);
  };

  for (const index of [...unmatchedWindowIndices]) {
    const openWindow = unresolvedWindows[index];
    if (!openWindow.runtime_id) continue;

    const matchingLiveWindows = [...unmatchedWindowIndices].filter((candidateIndex) => {
      const candidate = unresolvedWindows[candidateIndex];
      return candidate.bundle_id === openWindow.bundle_id &&
        candidate.runtime_id === openWindow.runtime_id;
    });
    const candidates = availableSavedTabs().filter(
      ([, savedTab]) =>
        savedTab.bundle_id === openWindow.bundle_id &&
        savedTab.runtime_id === openWindow.runtime_id,
    );
    if (matchingLiveWindows.length === 1 && candidates.length === 1) {
      matchWindow(index, candidates[0]);
    }
  }

  for (const index of [...unmatchedWindowIndices]) {
    const openWindow = unresolvedWindows[index];
    const matchingLiveWindows = unresolvedWindows.filter((candidate) => {
      return candidate.bundle_id === openWindow.bundle_id &&
        candidate.name === openWindow.name;
    });
    const matchingSavedTabs = [...savedByKey.entries()].filter(
      ([, savedTab]) =>
        savedTab.bundle_id === openWindow.bundle_id &&
        savedTab.name === openWindow.name,
    );
    const candidates = matchingSavedTabs.filter(([key]) => !liveByKey.has(key));
    if (
      matchingLiveWindows.length === 1 &&
      matchingSavedTabs.length === 1 &&
      candidates.length === 1
    ) {
      matchWindow(index, candidates[0]);
    }
  }

  const unmatchedUnresolvedWindows = unresolvedWindows.filter(
    (_, index) => unmatchedWindowIndices.has(index),
  );
  const nextSavedTabs = [...savedByKey.values()];
  const tabs = nextSavedTabs.map((tab) =>
    liveByKey.get(savedTabKey(tab)) ?? toClosedWindow(tab)
  );

  return {
    savedTabs: nextSavedTabs,
    tabs: [...tabs, ...unmatchedUnresolvedWindows],
  };
}

export function migrateSavedTabKeys(
  savedTabs: SavedTab[],
  currentWindows: EditorWindow[],
  nextWindows: EditorWindow[],
): SavedTab[] {
  const nextByRuntimeKey = new Map(
    nextWindows.map((window) => [runtimeWindowKey(window), window]),
  );
  const replacedKeys = new Set<string>();

  for (const current of currentWindows) {
    if (!current.path) continue;
    const next = nextByRuntimeKey.get(runtimeWindowKey(current));
    if (!next?.path) continue;
    if (windowKey(current) !== windowKey(next)) {
      replacedKeys.add(windowKey(current));
    }
  }

  if (replacedKeys.size === 0) return savedTabs;
  return savedTabs.filter((tab) => !replacedKeys.has(savedTabKey(tab)));
}

export function savedTabsDiffer(a: SavedTab[], b: SavedTab[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((tab, index) => {
    const other = b[index];
    return !other ||
      tab.runtime_id !== other.runtime_id ||
      tab.name !== other.name ||
      tab.path !== other.path ||
      tab.branch !== other.branch ||
      tab.repository_id !== other.repository_id ||
      tab.repository_name !== other.repository_name ||
      tab.bundle_id !== other.bundle_id ||
      tab.editor_name !== other.editor_name ||
      tab.resolution !== other.resolution;
  });
}

export function mergeProjectMetadata(
  savedTabs: SavedTab[],
  metadata: ProjectMetadata[],
): SavedTab[] {
  const metadataByPath = new Map(
    metadata.map((item) => [normalizeProjectPath(item.path), item]),
  );
  return savedTabs.map((tab) => {
    const item = metadataByPath.get(normalizeProjectPath(tab.path));
    if (!item) return tab;
    return {
      ...tab,
      branch: item.branch ?? undefined,
      repository_id: item.repository_id ?? undefined,
      repository_name: item.repository_name ?? undefined,
    };
  });
}

export function migrateLegacySavedTabs(
  savedTabs: SavedTab[],
  tabOrder: string[],
  history: HistoryEntry[],
): SavedTab[] {
  if (tabOrder.length === 0) return savedTabs;

  const historyByKey = new Map(
    history.flatMap((entry) => entry.bundleId
      ? [[`${entry.bundleId}:${normalizeProjectPath(entry.path)}`, entry] as const]
      : []),
  );
  const historyByLegacyName = new Map<string, Map<string, HistoryEntry>>();
  for (const entry of history) {
    if (!entry.bundleId || !entry.path) continue;
    const key = `${entry.bundleId}:${entry.name}`;
    const entriesByPath = historyByLegacyName.get(key) ??
      new Map<string, HistoryEntry>();
    entriesByPath.set(normalizeProjectPath(entry.path), entry);
    historyByLegacyName.set(key, entriesByPath);
  }
  const migrated = [...savedTabs];
  const migratedKeys = new Set(savedTabs.map(savedTabKey));
  let changed = false;
  const addMigratedTab = (tab: SavedTab) => {
    const key = savedTabKey(tab);
    if (migratedKeys.has(key)) return;
    migratedKeys.add(key);
    migrated.push(tab);
    changed = true;
  };

  for (const key of tabOrder) {
    const pathSeparatorIndex = key.indexOf(":/");
    if (pathSeparatorIndex >= 0) {
      const bundleId = key.slice(0, pathSeparatorIndex);
      const path = normalizeProjectPath(key.slice(pathSeparatorIndex + 1));
      const historyEntry = historyByKey.get(`${bundleId}:${path}`);
      addMigratedTab({
        name: historyEntry?.name || path.split("/").pop() || path,
        path,
        bundle_id: bundleId,
        editor_name: historyEntry?.editorName || EDITOR_DISPLAY_NAMES[bundleId] || bundleId,
      });
      continue;
    }

    const separatorIndex = key.indexOf(":");
    if (separatorIndex < 0) continue;
    const bundleId = key.slice(0, separatorIndex);
    const name = key.slice(separatorIndex + 1);
    if (!name || name.startsWith("runtime:")) continue;

    const historyEntries = historyByLegacyName.get(`${bundleId}:${name}`);
    if (!historyEntries || historyEntries.size !== 1) continue;
    const [path, historyEntry] = [...historyEntries.entries()][0];
    addMigratedTab({
      name: historyEntry.name,
      path,
      bundle_id: bundleId,
      editor_name: historyEntry.editorName || EDITOR_DISPLAY_NAMES[bundleId] || bundleId,
    });
  }

  return changed ? migrated : savedTabs;
}
