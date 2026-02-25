import { load } from "@tauri-apps/plugin-store";
import type { Store } from "@tauri-apps/plugin-store";
import type { EditorWindow, HistoryEntry } from "../types/editor";

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
