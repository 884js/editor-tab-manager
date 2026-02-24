import "@testing-library/jest-dom/vitest";

// ---- @tauri-apps/api/core ----
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ---- @tauri-apps/api/event ----
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// ---- @tauri-apps/api/window ----
const mockAppWindow = {
  show: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
  setSize: vi.fn().mockResolvedValue(undefined),
  setMaxSize: vi.fn().mockResolvedValue(undefined),
  setPosition: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => mockAppWindow),
  currentMonitor: vi.fn().mockResolvedValue({
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  }),
  primaryMonitor: vi.fn().mockResolvedValue({
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  }),
  LogicalSize: class LogicalSize {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
  },
  LogicalPosition: class LogicalPosition {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
}));

// ---- @tauri-apps/plugin-store ----
export function createMockStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async <T>(key: string) => (data.get(key) as T) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    keys: vi.fn(async () => [...data.keys()]),
    save: vi.fn(),
    _data: data,
  };
}

const defaultMockStore = createMockStore();

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockResolvedValue(defaultMockStore),
}));

// ---- @tauri-apps/plugin-notification ----
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

// ---- @tauri-apps/plugin-autostart ----
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  isEnabled: vi.fn().mockResolvedValue(false),
}));

// ---- @tauri-apps/plugin-dialog ----
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

// ---- react-i18next ----
vi.mock("react-i18next", () => ({
  useTranslation: vi.fn(() => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  })),
}));

// ---- i18n module (side-effect-only import) ----
vi.mock("../i18n", () => ({
  default: {
    t: (key: string) => key,
    changeLanguage: vi.fn(),
  },
}));
