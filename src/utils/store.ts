import { load } from "@tauri-apps/plugin-store";
import type { Store } from "@tauri-apps/plugin-store";
import type { EditorWindow, GroupAssignment, GroupDefinition, HistoryEntry, TabColorMap } from "../types/editor";

// Store instance (lazily initialized)
let storePromise: Promise<Store> | null = null;

export async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load("tab-order.json").catch((e) => {
      storePromise = null; // Reset so retry is possible
      throw e;
    });
  }
  return storePromise;
}

export const UNIFIED_ORDER_KEY = "order:unified";
export const UNIFIED_COLOR_KEY = "tabColor:unified";
export const GROUPS_DEFINITIONS_KEY = "groups:definitions";
export const GROUPS_ASSIGNMENTS_KEY = "groups:assignments";
export const GROUPS_COLLAPSED_KEY = "groups:collapsed";
export const GROUPS_COLORS_KEY = "groups:colors";

// Generic store helpers
async function loadValue<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const store = await getStore();
    return (await store.get<T>(key)) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

async function saveValue<T>(key: string, value: T): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key, value);
  } catch (error) {
    console.error(`Failed to save ${key}:`, error);
  }
}

export const loadTabOrder = () => loadValue<string[]>(UNIFIED_ORDER_KEY, []);
export const saveTabOrder = (order: string[]) => saveValue(UNIFIED_ORDER_KEY, order);
export const loadTabColors = () => loadValue<TabColorMap>(UNIFIED_COLOR_KEY, {});
export const saveTabColors = (colors: TabColorMap) => saveValue(UNIFIED_COLOR_KEY, colors);
export const loadHistory = () => loadValue<HistoryEntry[]>("history", []);
export const saveHistory = (entries: HistoryEntry[]) => saveValue("history", entries);
export const loadGroups = () => loadValue<GroupDefinition[]>(GROUPS_DEFINITIONS_KEY, []);
export const saveGroups = (groups: GroupDefinition[]) => saveValue(GROUPS_DEFINITIONS_KEY, groups);
export const loadGroupAssignments = () => loadValue<GroupAssignment>(GROUPS_ASSIGNMENTS_KEY, {});
export const saveGroupAssignments = (assignments: GroupAssignment) => saveValue(GROUPS_ASSIGNMENTS_KEY, assignments);
export const loadCollapsedGroups = () => loadValue<string[]>(GROUPS_COLLAPSED_KEY, []);
export const saveCollapsedGroups = (collapsedIds: string[]) => saveValue(GROUPS_COLLAPSED_KEY, collapsedIds);
export const loadGroupColors = () => loadValue<Record<string, string>>(GROUPS_COLORS_KEY, {});
export const saveGroupColors = (colors: Record<string, string>) => saveValue(GROUPS_COLORS_KEY, colors);

export function normalizeProjectPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function legacyWindowKey(w: EditorWindow): string {
  return `${w.bundle_id}:${w.name}`;
}

// Unique key for a window in the unified tab bar (handles worktrees with the same project name)
export function windowKey(w: EditorWindow): string {
  const identity = w.path ? normalizeProjectPath(w.path) : w.name;
  return `${w.bundle_id}:${identity}`;
}

export function repositoryColorKey(repositoryId: string): string {
  return `repository:${repositoryId}`;
}

export function projectPathMatchesWindow(projectPath: string, window: EditorWindow): boolean {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if (window.path) {
    return normalizedProjectPath === normalizeProjectPath(window.path);
  }
  return normalizedProjectPath.split("/").pop() === window.name;
}

export function getWindowScopedValue<T>(
  values: Record<string, T>,
  window: EditorWindow,
  legacyKey: string,
): T | undefined {
  const key = windowKey(window);
  if (Object.prototype.hasOwnProperty.call(values, key)) {
    return values[key];
  }
  return values[legacyKey];
}

// Sort windows by custom order, new windows go to the end
export function sortWindowsByOrder(windows: EditorWindow[], order: string[]): EditorWindow[] {
  const orderMap = new Map(order.map((key, index) => [key, index]));
  return [...windows].sort((a, b) => {
    const indexA = orderMap.get(windowKey(a)) ?? orderMap.get(legacyWindowKey(a)) ?? Infinity;
    const indexB = orderMap.get(windowKey(b)) ?? orderMap.get(legacyWindowKey(b)) ?? Infinity;
    if (indexA === Infinity && indexB === Infinity) {
      return a.name.localeCompare(b.name);
    }
    return indexA - indexB;
  });
}
