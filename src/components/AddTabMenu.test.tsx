import { fireEvent, render, screen } from "@testing-library/react";
import type { HistoryEntry } from "../types/editor";
import AddTabMenu from "./AddTabMenu";

const historyEntry: HistoryEntry = {
  name: "sample-project",
  path: "/Users/test/sample-project",
  timestamp: Date.now(),
};

function renderMenu(entries: HistoryEntry[] = [historyEntry]) {
  const onNewWindow = vi.fn().mockResolvedValue(undefined);
  const onSelectHistory = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn().mockResolvedValue(undefined);
  const anchor = document.createElement("button");

  render(
    <AddTabMenu
      entries={entries}
      onNewWindow={onNewWindow}
      onSelectHistory={onSelectHistory}
      onClearHistory={vi.fn()}
      onClose={onClose}
      anchorRef={{ current: anchor }}
    />,
  );

  return { onNewWindow, onSelectHistory, onClose };
}

describe("AddTabMenu", () => {
  it("requests an editor after selecting a recent project", async () => {
    const { onSelectHistory, onClose } = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: /^sample-project/ }));

    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
      expect(onSelectHistory).toHaveBeenCalledWith(historyEntry, expect.anything());
    });
  });

  it("requests an editor after selecting a new window", async () => {
    const { onNewWindow, onClose } = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: /history\.newWindow/ }));

    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
      expect(onNewWindow).toHaveBeenCalledWith(expect.anything());
    });
  });

  it("shows project history without editor-specific filtering", () => {
    renderMenu([
      historyEntry,
      {
        name: "another-project",
        path: "/Users/test/another-project",
        timestamp: Date.now() - 1000,
      },
    ]);

    expect(screen.getByRole("button", { name: /^sample-project/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^another-project/ })).toBeInTheDocument();
  });
});
