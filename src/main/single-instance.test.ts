import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { APP_ID, configureAppIdentity, installSingleInstance } from "./single-instance.js";

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

    configureAppIdentity(app, undefined, "darwin");

    expect(calls).toEqual([
      "userData:/Users/example/Library/Application Support/tau-pi-desktop-prototype",
      "name:Tau",
    ]);
  });

  it("gives Windows the AppUserModelID the installer's shortcut carries, so toasts show", async () => {
    const setAppUserModelId = vi.fn();
    const app = { getPath: () => "C:\\Users\\me\\AppData\\Roaming", setPath: vi.fn(), setName: vi.fn(), setAppUserModelId };
    configureAppIdentity(app, undefined, "win32");
    const builder = await readFile(new URL("../../tooling/electron-builder.yml", import.meta.url), "utf8");
    expect(builder).toContain(`appId: ${APP_ID}`);
    expect(setAppUserModelId).toHaveBeenCalledWith(APP_ID);
    configureAppIdentity(app, undefined, "darwin");
    expect(setAppUserModelId).toHaveBeenCalledOnce();
  });

  it("keeps the Windows install the former appId made, so the installer replaces it", async () => {
    const builder = await readFile(new URL("../../tooling/electron-builder.yml", import.meta.url), "utf8");
    expect(builder).toMatch(new RegExp(`^  guid: ${electronBuilderGuid("dev.tbuck.tau")}$`, "mu"));
    expect(builder).toContain("include: packaging/windows/installer.nsh");
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

/** UUID v5 of `name` in electron-builder's namespace: the NSIS GUID it derives from an appId. */
function electronBuilderGuid(name: string): string {
  const namespace = Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex");
  const hash = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
