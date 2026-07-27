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
    runtime_id: `saved:${key}`,
    ...tab,
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

  const unmatchedUnresolvedWindows: EditorWindow[] = [];
  for (const openWindow of unresolvedWindows) {
    const candidates = [...savedByKey.entries()].filter(
      ([key, savedTab]) =>
        !liveByKey.has(key) &&
        savedTab.bundle_id === openWindow.bundle_id &&
        savedTab.name === openWindow.name,
    );
    if (candidates.length !== 1) {
      unmatchedUnresolvedWindows.push(openWindow);
      continue;
    }

    const [key, savedTab] = candidates[0];
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
  }

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
      branch: tab.branch ?? item.branch ?? undefined,
      repository_id: tab.repository_id ?? item.repository_id ?? undefined,
      repository_name: tab.repository_name ?? item.repository_name ?? undefined,
    };
  });
}

export function migrateLegacySavedTabs(
  savedTabs: SavedTab[],
  tabOrder: string[],
  history: HistoryEntry[],
): SavedTab[] {
  if (savedTabs.length > 0 || tabOrder.length === 0) return savedTabs;

  const historyByKey = new Map(
    history.flatMap((entry) => entry.bundleId
      ? [[`${entry.bundleId}:${normalizeProjectPath(entry.path)}`, entry] as const]
      : []),
  );
  const migrated: SavedTab[] = [];

  for (const key of tabOrder) {
    const pathSeparatorIndex = key.indexOf(":/");
    if (pathSeparatorIndex < 0) continue;

    const bundleId = key.slice(0, pathSeparatorIndex);
    const path = normalizeProjectPath(key.slice(pathSeparatorIndex + 1));
    const historyEntry = historyByKey.get(`${bundleId}:${path}`);
    migrated.push({
      name: historyEntry?.name || path.split("/").pop() || path,
      path,
      bundle_id: bundleId,
      editor_name: historyEntry?.editorName || EDITOR_DISPLAY_NAMES[bundleId] || bundleId,
    });
  }

  return migrated;
}
