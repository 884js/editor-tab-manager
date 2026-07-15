import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditorWindow } from "../types/editor";
import { windowKey } from "../utils/store";
import TabBar from "./TabBar";

const cursorWindow: EditorWindow = {
  id: 1,
  name: "medii-e-consult-front",
  path: "/Users/test/projects/medii-e-consult-front",
  branch: "main",
  repository_id: "/Users/test/projects/medii-e-consult-front/.git",
  repository_name: "medii-e-consult-front",
  bundle_id: "com.todesktop.230313mzl4w4u92",
  editor_name: "Cursor",
};

const vscodeWorktree: EditorWindow = {
  id: 2,
  name: "medii-e-consult-front",
  path: "/Users/test/.codex/worktrees/a1b2/medii-e-consult-front",
  branch: "feature/search",
  repository_id: "/Users/test/projects/medii-e-consult-front/.git",
  repository_name: "medii-e-consult-front",
  bundle_id: "com.microsoft.VSCode",
  editor_name: "VSCode",
};

function setup() {
  const onAssignTabsToGroup = vi.fn();
  const props = {
    tabs: [cursorWindow, vscodeWorktree],
    activeIndex: 0,
    onTabClick: vi.fn(),
    onNewTab: vi.fn(),
    onCloseTab: vi.fn(),
    onReorder: vi.fn(),
    onReorderByVisual: vi.fn(),
    history: [],
    showAddMenu: false,
    onAddMenuOpen: vi.fn(),
    onAddMenuClose: vi.fn(),
    onHistorySelect: vi.fn(),
    onHistoryClear: vi.fn(),
    onColorPickerOpen: vi.fn().mockResolvedValue(undefined),
    onColorPickerClose: vi.fn(),
    groups: [
      { id: "medii", name: "medii", order: 0 },
      { id: "personal", name: "personal", order: 1 },
    ],
    groupAssignments: { [windowKey(cursorWindow)]: "medii" },
    collapsedGroups: new Set<string>(),
    onAddGroup: vi.fn(() => "new-group"),
    onUpdateGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    onAssignTabsToGroup,
    onUnassignTabsFromGroup: vi.fn(),
    onToggleGroupCollapse: vi.fn(),
    onReorderGroups: vi.fn(),
    groupColors: {},
    onSetGroupColor: vi.fn(),
    onTabContextMenuOpen: vi.fn().mockResolvedValue(undefined),
    onTabContextMenuClose: vi.fn().mockResolvedValue(undefined),
    onWorktreeMenuOpen: vi.fn().mockResolvedValue(undefined),
    onWorktreeMenuClose: vi.fn().mockResolvedValue(undefined),
  };

  render(<TabBar {...props} />);
  return { props, onAssignTabsToGroup };
}

describe("TabBar repository grouping", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("groups the same repository across editors and inherits its only manual group", () => {
    setup();

    const groupLabel = screen.getByRole("button", { name: "medii" });
    const group = groupLabel.closest(".tab-group");

    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByRole("button", {
      name: "worktree.openBranches",
    })).toBeInTheDocument();
  });

  it("assigns every repository window from the parent context menu", async () => {
    const { onAssignTabsToGroup } = setup();
    const trigger = screen.getByRole("button", { name: "worktree.openBranches" });

    fireEvent.contextMenu(trigger);
    const assignButton = await screen.findByRole("button", {
      name: "group.assignToGroup ▶",
    });
    fireEvent.mouseEnter(assignButton.parentElement as HTMLElement);
    const submenu = document.querySelector(".group-submenu");
    fireEvent.click(within(submenu as HTMLElement).getByRole("button", { name: "personal" }));

    await waitFor(() => {
      expect(onAssignTabsToGroup).toHaveBeenCalledWith(
        [windowKey(cursorWindow), windowKey(vscodeWorktree)],
        "personal",
      );
    });
  });
});
