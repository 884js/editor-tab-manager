import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EditorWindow } from "../types/editor";
import type { TabEntry } from "../utils/repositoryTabs";
import WorktreeTab from "./WorktreeTab";

function makeEntry(index: number, branch: string): TabEntry {
  const tab: EditorWindow = {
    id: index + 1,
    name: "project",
    path: `/worktrees/${branch}`,
    branch,
    repository_id: "/projects/project/.git",
    repository_name: "project",
    bundle_id: "com.microsoft.VSCode",
    editor_name: "VSCode",
  };
  return { tab, originalIndex: index };
}

function setup() {
  const props = {
    name: "project",
    entries: [makeEntry(2, "main"), makeEntry(5, "feature/search")],
    activeIndex: 5,
    statuses: new Map([[2, "waiting" as const], [5, "generating" as const]]),
    onTabClick: vi.fn(),
    onCloseTab: vi.fn(),
    onMenuOpen: vi.fn().mockResolvedValue(undefined),
    onMenuClose: vi.fn().mockResolvedValue(undefined),
  };
  const view = render(<WorktreeTab {...props} />);
  const trigger = screen.getByRole("button", { name: "worktree.openBranches" });
  return { ...view, props, trigger, root: trigger.parentElement as HTMLElement };
}

describe("WorktreeTab", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows branch rows on hover and expands for their count", () => {
    const { props, root } = setup();

    fireEvent.mouseEnter(root);

    expect(screen.getByRole("menu", { name: "worktree.branchList" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /main/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /feature\/search/ })).toBeInTheDocument();
    expect(props.onMenuOpen).toHaveBeenCalledWith(2);
  });

  it("switches to the selected editor window", () => {
    const { props, root } = setup();
    fireEvent.mouseEnter(root);

    fireEvent.click(screen.getByRole("menuitem", { name: /main/ }));

    expect(props.onTabClick).toHaveBeenCalledWith(2);
    expect(props.onMenuClose).toHaveBeenCalledOnce();
  });

  it("keeps the list open after click pins it", () => {
    vi.useFakeTimers();
    const { props, root, trigger } = setup();
    fireEvent.mouseEnter(root);
    fireEvent.click(trigger);

    fireEvent.mouseLeave(root);
    act(() => vi.advanceTimersByTime(250));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(props.onMenuClose).not.toHaveBeenCalled();
  });

  it("closes an unpinned hover list after the delay", () => {
    vi.useFakeTimers();
    const { props, root } = setup();
    fireEvent.mouseEnter(root);

    fireEvent.mouseLeave(root);
    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onMenuClose).toHaveBeenCalledOnce();
  });
});
