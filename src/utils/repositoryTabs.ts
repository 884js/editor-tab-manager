import type { EditorWindow } from "../types/editor";

export interface TabEntry {
  tab: EditorWindow;
  originalIndex: number;
}

export type RepositoryTabItem =
  | { type: "tab"; entry: TabEntry }
  | { type: "repository"; key: string; name: string; entries: TabEntry[] };

function repositoryKey(tab: EditorWindow): string | null {
  if (!tab.repository_id) return null;
  return `${tab.bundle_id}:${tab.repository_id}`;
}

export function groupRepositoryTabs(entries: TabEntry[]): RepositoryTabItem[] {
  const repositoryEntries = new Map<string, TabEntry[]>();

  for (const entry of entries) {
    const key = repositoryKey(entry.tab);
    if (!key) continue;
    const grouped = repositoryEntries.get(key) ?? [];
    grouped.push(entry);
    repositoryEntries.set(key, grouped);
  }

  const renderedRepositories = new Set<string>();
  const result: RepositoryTabItem[] = [];

  for (const entry of entries) {
    const key = repositoryKey(entry.tab);
    const grouped = key ? repositoryEntries.get(key) : undefined;
    if (!key || !grouped || grouped.length === 1) {
      result.push({ type: "tab", entry });
      continue;
    }
    if (renderedRepositories.has(key)) continue;

    renderedRepositories.add(key);
    result.push({
      type: "repository",
      key,
      name: entry.tab.repository_name || entry.tab.name,
      entries: grouped,
    });
  }

  return result;
}
