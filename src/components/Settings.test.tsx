import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import Settings from "./Settings";

const storeMocks = vi.hoisted(() => ({
  getStore: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  }),
  loadTabLayout: vi.fn().mockResolvedValue("horizontal"),
  saveTabLayout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/store", () => storeMocks);

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    language: "ja",
    changeLanguage: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

describe("Settings tab layout", () => {
  beforeEach(() => {
    storeMocks.loadTabLayout.mockClear();
    storeMocks.saveTabLayout.mockClear();
    vi.mocked(emit).mockClear();
  });

  it("loads the saved layout and emits changes", async () => {
    render(<Settings />);

    const horizontal = await screen.findByRole("radio", {
      name: /settings\.tabLayout\.horizontal/,
    });
    const list = screen.getByRole("radio", {
      name: /settings\.tabLayout\.list/,
    });

    expect(horizontal).toBeChecked();
    expect(storeMocks.loadTabLayout).toHaveBeenCalledOnce();

    fireEvent.click(list);

    await waitFor(() => {
      expect(storeMocks.saveTabLayout).toHaveBeenCalledWith("list");
      expect(emit).toHaveBeenCalledWith("tab-layout-changed", "list");
    });
    expect(list).toBeChecked();
  });
});
