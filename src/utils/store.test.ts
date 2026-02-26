import { load } from "@tauri-apps/plugin-store";
import { createMockStore } from "../test/setup";
import type { EditorWindow } from "../types/editor";
import {
  windowKey,
  sortWindowsByOrder,
  UNIFIED_ORDER_KEY,
  UNIFIED_COLOR_KEY,
} from "./store";

// Reset the cached storePromise between tests by re-importing fresh module
// We use vi.resetModules + dynamic import for getStore tests, but for the rest
// we rely on the mock store returned by `load`.

function makeWindow(overrides: Partial<EditorWindow> = {}): EditorWindow {
  return {
    id: 1,
    name: "my-project",
    path: "/Users/test/my-project",
    bundle_id: "com.microsoft.VSCode",
    editor_name: "VSCode",
    ...overrides,
  };
}

// ────────────────────────────────
// Pure functions (no mocks needed)
// ────────────────────────────────

describe("windowKey", () => {
  it("returns bundle_id:name format", () => {
    const w = makeWindow({ bundle_id: "com.microsoft.VSCode", name: "proj" });
    expect(windowKey(w)).toBe("com.microsoft.VSCode:proj");
  });

  it("handles different editors with same project name", () => {
    const a = makeWindow({ bundle_id: "com.microsoft.VSCode", name: "proj" });
    const b = makeWindow({ bundle_id: "dev.zed.Zed", name: "proj" });
    expect(windowKey(a)).not.toBe(windowKey(b));
  });
});

describe("sortWindowsByOrder", () => {
  const w1 = makeWindow({ name: "alpha", bundle_id: "com.microsoft.VSCode" });
  const w2 = makeWindow({ name: "beta", bundle_id: "com.microsoft.VSCode" });
  const w3 = makeWindow({ name: "gamma", bundle_id: "dev.zed.Zed" });

  it("sorts by custom order", () => {
    const order = [windowKey(w3), windowKey(w1), windowKey(w2)];
    const result = sortWindowsByOrder([w1, w2, w3], order);
    expect(result.map((w) => w.name)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("puts new (unknown) windows at the end, sorted alphabetically", () => {
    const order = [windowKey(w2)];
    const result = sortWindowsByOrder([w3, w1, w2], order);
    expect(result[0].name).toBe("beta"); // ordered
    // new windows alphabetically
    expect(result[1].name).toBe("alpha");
    expect(result[2].name).toBe("gamma");
  });

  it("returns empty array for empty input", () => {
    expect(sortWindowsByOrder([], ["key"])).toEqual([]);
  });

  it("handles empty order — all windows sorted alphabetically", () => {
    const result = sortWindowsByOrder([w2, w1], []);
    expect(result.map((w) => w.name)).toEqual(["alpha", "beta"]);
  });

  it("does not mutate the original array", () => {
    const original = [w2, w1];
    sortWindowsByOrder(original, []);
    expect(original[0].name).toBe("beta"); // unchanged
  });
});

// ────────────────────────────────
// Store functions (mocked Store)
// ────────────────────────────────

describe("Store functions", () => {
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(async () => {
    mockStore = createMockStore();
    vi.mocked(load).mockClear();
    vi.mocked(load).mockResolvedValue(mockStore as never);
    // Reset cached store promise by clearing module cache
    vi.resetModules();
  });

  // We need to dynamically import to get fresh module after resetModules
  async function freshImport() {
    const mod = await import("./store");
    return mod;
  }

  describe("getStore", () => {
    it("returns a Store instance", async () => {
      const { getStore } = await freshImport();
      const store = await getStore();
      expect(store).toBe(mockStore);
    });

    it("caches the store promise on subsequent calls", async () => {
      const { getStore } = await freshImport();
      await getStore();
      await getStore();
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("resets cache on error so retry is possible", async () => {
      vi.mocked(load)
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(mockStore as never);

      const { getStore } = await freshImport();
      await expect(getStore()).rejects.toThrow("fail");
      // Second call should retry
      const store = await getStore();
      expect(store).toBe(mockStore);
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe("loadTabOrder / saveTabOrder", () => {
    it("returns empty array when no data", async () => {
      const { loadTabOrder } = await freshImport();
      const result = await loadTabOrder();
      expect(result).toEqual([]);
    });

    it("saves and loads tab order", async () => {
      const { loadTabOrder, saveTabOrder } = await freshImport();
      await saveTabOrder(["a", "b", "c"]);
      const result = await loadTabOrder();
      expect(result).toEqual(["a", "b", "c"]);
    });

    it("uses the correct store key", async () => {
      const { saveTabOrder } = await freshImport();
      await saveTabOrder(["x"]);
      expect(mockStore.set).toHaveBeenCalledWith(UNIFIED_ORDER_KEY, ["x"]);
    });

    it("returns empty array on error", async () => {
      vi.mocked(load).mockRejectedValue(new Error("broken"));
      const { loadTabOrder } = await freshImport();
      const result = await loadTabOrder();
      expect(result).toEqual([]);
    });
  });

  describe("loadTabColors / saveTabColors", () => {
    it("returns empty object when no data", async () => {
      const { loadTabColors } = await freshImport();
      const result = await loadTabColors();
      expect(result).toEqual({});
    });

    it("saves and loads tab colors", async () => {
      const { loadTabColors, saveTabColors } = await freshImport();
      await saveTabColors({ proj: "red" });
      const result = await loadTabColors();
      expect(result).toEqual({ proj: "red" });
    });

    it("uses the correct store key", async () => {
      const { saveTabColors } = await freshImport();
      await saveTabColors({ x: "blue" });
      expect(mockStore.set).toHaveBeenCalledWith(UNIFIED_COLOR_KEY, { x: "blue" });
    });

    it("returns empty object on error", async () => {
      vi.mocked(load).mockRejectedValue(new Error("broken"));
      const { loadTabColors } = await freshImport();
      const result = await loadTabColors();
      expect(result).toEqual({});
    });
  });

  describe("loadHistory / saveHistory", () => {
    it("returns empty array when no data", async () => {
      const { loadHistory } = await freshImport();
      const result = await loadHistory();
      expect(result).toEqual([]);
    });

    it("saves and loads history", async () => {
      const { loadHistory, saveHistory } = await freshImport();
      const entries = [
        { name: "proj", path: "/path", bundleId: "com.microsoft.VSCode", editorName: "VSCode", timestamp: 1000 },
      ];
      await saveHistory(entries);
      const result = await loadHistory();
      expect(result).toEqual(entries);
    });

    it("returns empty array on error", async () => {
      vi.mocked(load).mockRejectedValue(new Error("broken"));
      const { loadHistory } = await freshImport();
      const result = await loadHistory();
      expect(result).toEqual([]);
    });
  });
});
