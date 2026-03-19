import { load } from "@tauri-apps/plugin-store";
import type { Store } from "@tauri-apps/plugin-store";
import type { EditorWindow, GroupAssignment, GroupDefinition, HistoryEntry } from "../types/editor";

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
export const loadTabColors = () => loadValue<Record<string, string>>(UNIFIED_COLOR_KEY, {});
export const saveTabColors = (colors: Record<string, string>) => saveValue(UNIFIED_COLOR_KEY, colors);
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

// Unique key for a window in the unified tab bar (handles same project name in different editors)
export function windowKey(w: EditorWindow): string {
  return `${w.bundle_id}:${w.name}`;
}

// Sort windows by custom order, new windows go to the end
export function sortWindowsByOrder(windows: EditorWindow[], order: string[]): EditorWindow[] {
  const orderMap = new Map(order.map((key, index) => [key, index]));
  return [...windows].sort((a, b) => {
    const indexA = orderMap.get(windowKey(a)) ?? Infinity;
    const indexB = orderMap.get(windowKey(b)) ?? Infinity;
    if (indexA === Infinity && indexB === Infinity) {
      return a.name.localeCompare(b.name);
    }
    return indexA - indexB;
  });
}
