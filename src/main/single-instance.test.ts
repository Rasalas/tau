import { describe, expect, it, vi } from "vitest";
import { configureAppIdentity, installSingleInstance } from "./single-instance.js";

function fakeApp(lock: boolean) {
  const listeners = new Map<string, () => void>();
  return {
    app: {
      requestSingleInstanceLock: vi.fn(() => lock),
      quit: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener); }),
    },
    listeners,
  };
}

describe("single Electron instance", () => {
  it("keeps the established user-data directory when the visible app name becomes Tau", () => {
    const calls: string[] = [];
    const app = {
      getPath: vi.fn(() => "/Users/example/Library/Application Support"),
      setPath: vi.fn((name: string, path: string) => { calls.push(`${name}:${path}`); }),
      setName: vi.fn((name: string) => { calls.push(`name:${name}`); }),
    };

    configureAppIdentity(app);

    expect(calls).toEqual([
      "userData:/Users/example/Library/Application Support/tau-pi-desktop-prototype",
      "name:Tau",
    ]);
  });

  it("quits a second process before it starts the workbench", () => {
    const { app } = fakeApp(false);

    expect(installSingleInstance(app, () => undefined)).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.on).not.toHaveBeenCalled();
  });

  it("restores and focuses the existing window when another start is attempted", () => {
    const { app, listeners } = fakeApp(true);
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(installSingleInstance(app, () => window)).toBe(true);
    listeners.get("second-instance")?.();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
