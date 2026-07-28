import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import type { EditorWindow } from "../types/editor";
import { repositoryColorKey, windowKey } from "../utils/store";
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

const zedWorktree: EditorWindow = {
  id: 3,
  name: "medii-e-consult-front",
  path: "/Users/test/.codex/worktrees/c3d4/medii-e-consult-front",
  branch: "fix/validation",
  repository_id: "/Users/test/projects/medii-e-consult-front/.git",
  repository_name: "medii-e-consult-front",
  bundle_id: "dev.zed.Zed",
  editor_name: "Zed",
};

const standaloneWindow: EditorWindow = {
  id: 4,
  name: "medii-e-consult-api",
  path: "/Users/test/projects/medii-e-consult-api",
  branch: "main",
  bundle_id: "com.todesktop.230313mzl4w4u92",
  editor_name: "Cursor",
};

function StatefulTabBar(props: ComponentProps<typeof TabBar>) {
  const [showAddMenu, setShowAddMenu] = useState(props.showAddMenu);

  return (
    <TabBar
      {...props}
      showAddMenu={showAddMenu}
      onAddMenuHandoff={() => {
        props.onAddMenuHandoff();
        setShowAddMenu(false);
      }}
    />
  );
}

function setup(
  tabColors: Record<string, string | null> = {},
  tabLayout: "horizontal" | "list" = "horizontal",
  tabs: EditorWindow[] = [cursorWindow, vscodeWorktree],
  groupAssignments: Record<string, string | null> = {
    [windowKey(cursorWindow)]: "medii",
  },
  overrides: Partial<ComponentProps<typeof TabBar>> = {},
) {
  const onAssignTabsToGroup = vi.fn();
  const onColorChange = vi.fn();
  const props = {
    tabs,
    activeIndex: 0,
    onTabClick: vi.fn(),
    onNewTab: vi.fn().mockResolvedValue(true),
    onCloseTab: vi.fn(),
    onReorder: vi.fn(),
    onReorderByVisual: vi.fn(),
    history: [],
    showAddMenu: false,
    onAddMenuOpen: vi.fn(),
    onAddMenuClose: vi.fn().mockResolvedValue(undefined),
    onAddMenuHandoff: vi.fn(),
    onEditorPickerOpen: vi.fn().mockResolvedValue(undefined),
    onEditorPickerClose: vi.fn().mockResolvedValue(undefined),
    onHistorySelect: vi.fn().mockResolvedValue(true),
    onClosedTabOpen: vi.fn().mockResolvedValue(true),
    onHistoryClear: vi.fn(),
    onColorPickerOpen: vi.fn().mockResolvedValue(undefined),
    onColorPickerClose: vi.fn(),
    tabColors,
    tabLayout,
    onColorChange,
    groups: [
      { id: "medii", name: "medii", order: 0 },
      { id: "personal", name: "personal", order: 1 },
    ],
    groupAssignments,
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
    ...overrides,
  };

  const view = render(<StatefulTabBar {...props} />);
  return {
    props,
    onAssignTabsToGroup,
    onColorChange,
    rerenderTabs: (nextTabs: EditorWindow[]) => {
      view.rerender(<StatefulTabBar {...props} tabs={nextTabs} />);
    },
  };
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

  it("does not inherit a same-named legacy group assignment from another editor", () => {
    const movedTab = {
      ...standaloneWindow,
      bundle_id: "com.microsoft.VSCode",
      editor_name: "VSCode",
      is_open: false,
    };
    setup(
      {},
      "horizontal",
      [movedTab],
      { [`${standaloneWindow.bundle_id}:${standaloneWindow.name}`]: "medii" },
    );

    expect(
      screen.getByTitle("tabBar.closedTooltip").closest(".tab-group"),
    ).toBeNull();
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

  it("stores and displays a color for the aggregate repository tab", async () => {
    const colorKey = repositoryColorKey(cursorWindow.repository_id!);
    const { onColorChange } = setup({ [colorKey]: "red" });
    const trigger = screen.getByRole("button", { name: "worktree.openBranches" });

    expect(trigger).toHaveStyle({ background: "rgb(110, 81, 83)" });

    fireEvent.contextMenu(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "tabColor.title" }));
    fireEvent.click(await screen.findByTitle("tabColor.blue"));

    expect(onColorChange).toHaveBeenCalledWith(colorKey, "blue");
  });

  it("shows grouped worktrees as rows in list layout", () => {
    const { props } = setup({}, "list");
    const groupButton = screen.getByRole("button", { name: /medii/ });

    expect(screen.queryByRole("button", { name: "worktree.openBranches" })).not.toBeInTheDocument();

    fireEvent.click(groupButton);

    expect(screen.getByRole("menu", { name: "group.tabList" })).toBeInTheDocument();
    const repository = screen.getByRole("menuitem", { name: /medii-e-consult-front/ });
    expect(repository).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: /main/ })).not.toBeInTheDocument();
    expect(props.onWorktreeMenuOpen).toHaveBeenLastCalledWith(1);

    fireEvent.click(repository);

    expect(screen.getByRole("menuitem", { name: /main/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /feature\/search/ })).toBeInTheDocument();
    expect(props.onWorktreeMenuOpen).toHaveBeenLastCalledWith(3);
  });

  it("shows repository worktree rows before regular tabs in list layout", () => {
    setup(
      {},
      "list",
      [standaloneWindow, cursorWindow, vscodeWorktree],
      {
        [windowKey(standaloneWindow)]: "medii",
        [windowKey(cursorWindow)]: "medii",
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /medii/ }));

    const items = within(screen.getByRole("menu", { name: "group.tabList" }))
      .getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("medii-e-consult-front");
    expect(items[1]).toHaveTextContent("medii-e-consult-api");
  });

  it("keeps a repository expanded after a tab closes and the list reopens", () => {
    const { props, rerenderTabs } = setup(
      {},
      "list",
      [cursorWindow, vscodeWorktree, zedWorktree],
    );
    const groupButton = screen.getByRole("button", { name: /medii/ });
    fireEvent.click(groupButton);
    fireEvent.click(screen.getByRole("menuitem", { name: /medii-e-consult-front/ }));

    fireEvent.click(screen.getAllByRole("button", { name: "tabBar.removeTooltip" })[2]);
    expect(props.onCloseTab).toHaveBeenCalledWith(2);
    rerenderTabs([cursorWindow, vscodeWorktree]);

    fireEvent.click(groupButton);
    fireEvent.click(groupButton);

    const repository = screen.getByRole("menuitem", { name: /medii-e-consult-front/ });
    expect(repository).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: /main/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /feature\/search/ })).toBeInTheDocument();
  });

  it("switches windows from the group list and closes it", () => {
    const { props } = setup({}, "list");
    fireEvent.click(screen.getByRole("button", { name: /medii/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /medii-e-consult-front/ }));

    fireEvent.click(screen.getByRole("menuitem", { name: /feature\/search/ }));

    expect(props.onTabClick).toHaveBeenCalledWith(1);
    expect(props.onWorktreeMenuClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "group.tabList" })).not.toBeInTheDocument();
  });

  it("shows an editor picker when clicking a closed tab", async () => {
    const closedTab = { ...standaloneWindow, is_open: false };
    const { props } = setup({}, "horizontal", [closedTab], {});

    const tab = screen.getByTitle("tabBar.closedTooltip");
    expect(tab).toHaveStyle({ opacity: "0.55" });
    expect(screen.getByLabelText("tabBar.closedLabel")).toBeInTheDocument();

    fireEvent.click(tab);
    expect(
      await screen.findByRole("dialog", { name: "history.chooseEditor" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
    expect(props.onClosedTabOpen).toHaveBeenCalledWith(
      0,
      "com.todesktop.230313mzl4w4u92",
      undefined,
    );
    expect(props.onTabClick).not.toHaveBeenCalled();
  });

  it("hands off a recent project to the editor picker without resizing", async () => {
    const historyEntry = {
      name: "sample-project",
      path: "/Users/test/sample-project",
      timestamp: Date.now(),
    };
    const { props } = setup(
      {},
      "horizontal",
      [standaloneWindow],
      {},
      {
        history: [historyEntry],
        showAddMenu: true,
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /^sample-project/ }));

    expect(
      await screen.findByRole("dialog", { name: "history.chooseEditor" }),
    ).toBeInTheDocument();
    expect(props.onAddMenuHandoff).toHaveBeenCalledOnce();
    expect(props.onAddMenuClose).not.toHaveBeenCalled();
    expect(props.onEditorPickerOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^sample-project/ })).not.toBeInTheDocument();
  });

  it("hands off a new window to the editor picker without resizing", async () => {
    const { props } = setup(
      {},
      "horizontal",
      [standaloneWindow],
      {},
      {
        showAddMenu: true,
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /history\.newWindow/ }));

    expect(
      await screen.findByRole("dialog", { name: "history.chooseEditor" }),
    ).toBeInTheDocument();
    expect(props.onAddMenuHandoff).toHaveBeenCalledOnce();
    expect(props.onAddMenuClose).not.toHaveBeenCalled();
    expect(props.onEditorPickerOpen).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /history\.newWindow/ }),
    ).not.toBeInTheDocument();
  });

  it("preserves an inherited group when opening a closed worktree tab", async () => {
    const closedWorktree = { ...vscodeWorktree, is_open: false };
    const { props } = setup(
      {},
      "list",
      [cursorWindow, closedWorktree],
      { [windowKey(cursorWindow)]: "medii" },
    );

    fireEvent.click(screen.getByRole("button", { name: /medii/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /medii-e-consult-front/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /feature\/search/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Zed" }));

    expect(props.onClosedTabOpen).toHaveBeenCalledWith(
      1,
      "dev.zed.Zed",
      "medii",
    );
  });
});
