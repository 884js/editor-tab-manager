import { fireEvent, render, screen } from "@testing-library/react";
import EditorPicker from "./EditorPicker";

const anchorRect = {
  left: 8,
  right: 108,
  top: 0,
  bottom: 32,
  width: 100,
  height: 32,
  x: 8,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

describe("EditorPicker", () => {
  it("opens the target with the selected editor", async () => {
    const onSelect = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
      <EditorPicker
        targetName="sample-project"
        anchorRect={anchorRect}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));

    expect(onSelect).toHaveBeenCalledWith("com.todesktop.230313mzl4w4u92");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("keeps the picker open and shows an error when opening fails", async () => {
    render(
      <EditorPicker
        targetName="sample-project"
        anchorRect={anchorRect}
        onSelect={vi.fn().mockResolvedValue(false)}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zed" }));

    expect(await screen.findByRole("status")).toHaveTextContent("history.openFailed");
    expect(screen.getByRole("dialog", { name: "history.chooseEditor" })).toBeInTheDocument();
  });
});
