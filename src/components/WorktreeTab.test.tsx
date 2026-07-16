import { fireEvent, render, screen } from "@testing-library/react";
import type { EditorWindow } from "../types/editor";
import type { TabEntry } from "../utils/repositoryTabs";
import WorktreeTab from "./WorktreeTab";

function makeEntry(index: number, branch: string, overrides: Partial<EditorWindow> = {}): TabEntry {
  const tab: EditorWindow = {
    id: index + 1,
    name: "project",
    path: `/worktrees/${branch}`,
    branch,
    repository_id: "/projects/project/.git",
    repository_name: "project",
    bundle_id: "com.microsoft.VSCode",
    editor_name: "VSCode",
    ...overrides,
  };
  return { tab, originalIndex: index };
}

function setup() {
  const props = {
    name: "project",
    entries: [
      makeEntry(2, "main"),
      makeEntry(5, "feature/search", {
        bundle_id: "com.todesktop.230313mzl4w4u92",
        editor_name: "Cursor",
      }),
    ],
    activeIndex: 5,
    statuses: new Map([[2, "waiting" as const], [5, "generating" as const]]),
    onTabClick: vi.fn(),
    onCloseTab: vi.fn(),
    onMenuOpen: vi.fn().mockResolvedValue(undefined),
    onMenuClose: vi.fn().mockResolvedValue(undefined),
    onContextMenu: vi.fn(),
  };
  const view = render(<WorktreeTab {...props} />);
  const trigger = screen.getByRole("button", { name: "worktree.openBranches" });
  return { ...view, props, trigger, root: trigger.parentElement as HTMLElement };
}

describe("WorktreeTab", () => {
  it("shows branch rows on click and expands for their count", () => {
    const { props, trigger } = setup();

    fireEvent.click(trigger);

    expect(screen.getByRole("menu", { name: "worktree.branchList" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /main/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /feature\/search/ })).toBeInTheDocument();
    expect(screen.getByText("VSCode")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(props.onMenuOpen).toHaveBeenCalledWith(2);
  });

  it("opens on primary mouse down without toggling again on click", () => {
    const { props, trigger } = setup();

    fireEvent.mouseDown(trigger, { button: 0 });
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(props.onMenuOpen).toHaveBeenCalledOnce();
    expect(props.onMenuClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onMenuClose).toHaveBeenCalledOnce();
  });

  it("opens the parent context menu for every repository window", () => {
    const { props, trigger } = setup();

    fireEvent.contextMenu(trigger);

    expect(props.onContextMenu).toHaveBeenCalledWith(
      [2, 5],
      5,
      expect.objectContaining({ left: 0, bottom: 0 }),
    );
  });

  it("switches to the selected editor window", () => {
    const { props, trigger } = setup();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("menuitem", { name: /main/ }));

    expect(props.onTabClick).toHaveBeenCalledWith(2);
    expect(props.onMenuClose).toHaveBeenCalledOnce();
  });

  it("toggles the list with repeated clicks", () => {
    const { props, trigger } = setup();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onMenuClose).toHaveBeenCalledOnce();
  });

  it("does not open the list on hover", () => {
    const { root } = setup();

    fireEvent.mouseEnter(root);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the list when clicking outside", () => {
    const { props, trigger } = setup();
    fireEvent.click(trigger);

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onMenuClose).toHaveBeenCalledOnce();
  });
});
