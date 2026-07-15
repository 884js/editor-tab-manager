import type { EditorWindow } from "../types/editor";
import { groupRepositoryTabs, type TabEntry } from "./repositoryTabs";

function makeEntry(index: number, overrides: Partial<EditorWindow> = {}): TabEntry {
  return {
    originalIndex: index,
    tab: {
      id: index + 1,
      name: `project-${index}`,
      path: `/worktrees/project-${index}`,
      branch: `branch-${index}`,
      repository_id: `/projects/project/.git`,
      repository_name: "project",
      bundle_id: "com.microsoft.VSCode",
      editor_name: "VSCode",
      ...overrides,
    },
  };
}

describe("groupRepositoryTabs", () => {
  it("groups worktrees from the same repository and editor", () => {
    const result = groupRepositoryTabs([makeEntry(0), makeEntry(1)]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "repository",
      name: "project",
      entries: [{ originalIndex: 0 }, { originalIndex: 1 }],
    });
  });

  it("keeps a single repository window as a normal tab", () => {
    const entry = makeEntry(0);
    expect(groupRepositoryTabs([entry])).toEqual([{ type: "tab", entry }]);
  });

  it("does not group the same repository across different editors", () => {
    const result = groupRepositoryTabs([
      makeEntry(0),
      makeEntry(1, { bundle_id: "com.todesktop.230313mzl4w4u92" }),
    ]);

    expect(result.map((item) => item.type)).toEqual(["tab", "tab"]);
  });

  it("does not group different repositories", () => {
    const result = groupRepositoryTabs([
      makeEntry(0),
      makeEntry(1, { repository_id: "/projects/another/.git", repository_name: "another" }),
    ]);

    expect(result.map((item) => item.type)).toEqual(["tab", "tab"]);
  });

  it("keeps the first repository position in the tab order", () => {
    const standalone = makeEntry(0, { repository_id: undefined, repository_name: undefined });
    const firstWorktree = makeEntry(1);
    const secondWorktree = makeEntry(2);

    const result = groupRepositoryTabs([standalone, firstWorktree, secondWorktree]);

    expect(result[0]).toEqual({ type: "tab", entry: standalone });
    expect(result[1]).toMatchObject({ type: "repository", entries: [firstWorktree, secondWorktree] });
  });
});
