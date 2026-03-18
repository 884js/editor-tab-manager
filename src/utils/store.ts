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

// Load tab order from Store
export async function loadTabOrder(): Promise<string[]> {
  try {
    const store = await getStore();
    return (await store.get<string[]>(UNIFIED_ORDER_KEY)) || [];
  } catch {
    return [];
  }
}

// Save tab order to Store
export async function saveTabOrder(order: string[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set(UNIFIED_ORDER_KEY, order);
  } catch (error) {
    console.error("Failed to save tab order:", error);
  }
}

// Load tab colors from Store
export async function loadTabColors(): Promise<Record<string, string>> {
  try {
    const store = await getStore();
    return (await store.get<Record<string, string>>(UNIFIED_COLOR_KEY)) || {};
  } catch {
    return {};
  }
}

// Save tab colors to Store
export async function saveTabColors(colors: Record<string, string>): Promise<void> {
  try {
    const store = await getStore();
    await store.set(UNIFIED_COLOR_KEY, colors);
  } catch (error) {
    console.error("Failed to save tab colors:", error);
  }
}

// Load history from Store
export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const store = await getStore();
    return (await store.get<HistoryEntry[]>("history")) || [];
  } catch {
    return [];
  }
}

// Save history to Store
export async function saveHistory(entries: HistoryEntry[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set("history", entries);
  } catch (error) {
    console.error("Failed to save history:", error);
  }
}

// Unique key for a window in the unified tab bar (handles same project name in different editors)
export function windowKey(w: EditorWindow): string {
  return `${w.bundle_id}:${w.name}`;
}

// Load group definitions from Store
export async function loadGroups(): Promise<GroupDefinition[]> {
  try {
    const store = await getStore();
    return (await store.get<GroupDefinition[]>(GROUPS_DEFINITIONS_KEY)) || [];
  } catch {
    return [];
  }
}

// Save group definitions to Store
export async function saveGroups(groups: GroupDefinition[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set(GROUPS_DEFINITIONS_KEY, groups);
  } catch (error) {
    console.error("Failed to save groups:", error);
  }
}

// Load group assignments from Store
export async function loadGroupAssignments(): Promise<GroupAssignment> {
  try {
    const store = await getStore();
    return (await store.get<GroupAssignment>(GROUPS_ASSIGNMENTS_KEY)) || {};
  } catch {
    return {};
  }
}

// Save group assignments to Store
export async function saveGroupAssignments(assignments: GroupAssignment): Promise<void> {
  try {
    const store = await getStore();
    await store.set(GROUPS_ASSIGNMENTS_KEY, assignments);
  } catch (error) {
    console.error("Failed to save group assignments:", error);
  }
}

// Load collapsed group IDs from Store
export async function loadCollapsedGroups(): Promise<string[]> {
  try {
    const store = await getStore();
    return (await store.get<string[]>(GROUPS_COLLAPSED_KEY)) || [];
  } catch {
    return [];
  }
}

// Save collapsed group IDs to Store
export async function saveCollapsedGroups(collapsedIds: string[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set(GROUPS_COLLAPSED_KEY, collapsedIds);
  } catch (error) {
    console.error("Failed to save collapsed groups:", error);
  }
}

// Load group colors from Store
export async function loadGroupColors(): Promise<Record<string, string>> {
  try {
    const store = await getStore();
    return (await store.get<Record<string, string>>(GROUPS_COLORS_KEY)) || {};
  } catch {
    return {};
  }
}

// Save group colors to Store
export async function saveGroupColors(colors: Record<string, string>): Promise<void> {
  try {
    const store = await getStore();
    await store.set(GROUPS_COLORS_KEY, colors);
  } catch (error) {
    console.error("Failed to save group colors:", error);
  }
}

// Sort windows by custom order, new windows go to the end
export function sortWindowsByOrder(windows: EditorWindow[], order: string[]): EditorWindow[] {
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
