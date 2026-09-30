import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  WebContentsView: vi.fn(),
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  desktopCapturer: { getSources: vi.fn(async () => [] as Array<{ id: string; name: string }>) },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "granted"), isTrustedAccessibilityClient: vi.fn(() => true) },
}));
vi.mock("electron", () => electron);

const { captureResolved, default: activate, frontWindow, namedWindow, readAccess, windowIdOfSource } = await import("./window.js");

type Client = Parameters<typeof frontWindow>[0];
const element = (name: string, active = false, bounds = { x: 100, y: 50, width: 400, height: 300 }) => ({
  role: "window", name, value: null, description: null, bounds, actions: [], enabled: true, focused: false, selected: false,
  editable: false, expanded: null, checked: null, active,
  children: async () => [{ role: "button", name: "Press me", value: null, description: null, bounds: { x: 150, y: 100, width: 50, height: 20 }, actions: ["press"], enabled: true, focused: false, selected: false, editable: false, expanded: null, checked: null, children: async () => [] }],
});
const client = (windows: ReturnType<typeof element>[], pid: number | null = 59103): Client => {
  const app = { name: "Electron", pid, windows: vi.fn(async () => windows) };
  return { App: { foreground: vi.fn(async () => app), byPid: vi.fn(async () => app) } } as unknown as Client;
};
const sources = (...entries: Array<[number, string]>) => async () => entries.map(([id, name]) => ({ id: `window:${id}:0`, name }));

const half = (loadDependency?: (name: string) => Promise<unknown>) => {
  const invokeHost = vi.fn(async () => undefined);
  return { half: activate({ id: "tau.snapshots", invokeHost, log: () => undefined, ...(loadDependency ? { loadDependency } : {}) }), invokeHost };
};

// The half acts on macOS only; CI runs on Linux.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeAll(() => { Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); });
afterAll(() => { Object.defineProperty(process, "platform", platform); });

beforeEach(() => {
  vi.clearAllMocks();
  electron.systemPreferences.getMediaAccessStatus.mockReturnValue("granted");
  electron.systemPreferences.isTrustedAccessibilityClient.mockReturnValue(true);
  electron.globalShortcut.register.mockReturnValue(true);
});

describe("SnapShots' window half", () => {
  it("reads both macOS permissions without asking, and nothing elsewhere", () => {
    expect(readAccess("darwin", () => "granted", () => false)).toEqual({ supported: true, screen: "granted", accessibility: "denied" });
    expect(readAccess("darwin", () => "odd", () => true)).toEqual({ supported: true, screen: "unavailable", accessibility: "granted" });
    expect(readAccess("linux", () => "granted", () => true, {})).toEqual({ supported: true, screen: "unavailable", accessibility: "unavailable" });
    const macProbe = vi.fn(() => { throw new Error("macOS only"); });
    expect(readAccess("win32", macProbe, macProbe)).toEqual({ supported: true, screen: "granted", accessibility: "granted" });
    expect(readAccess("linux", macProbe, macProbe, { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/session" })).toEqual({ supported: true, screen: "granted", accessibility: "granted" });
    expect(readAccess("linux", macProbe, macProbe, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/session" })).toEqual({ supported: true, captureMode: "picker", screen: "not-determined", accessibility: "unavailable" });
    expect(macProbe).not.toHaveBeenCalled();
    expect(windowIdOfSource("window:35210:0")).toBe(35210);
    expect(windowIdOfSource("screen:1:0")).toBeUndefined();
  });

  it("finds the window in front by its title among the windows it may record", async () => {
    const draft = element("Draft", true);
    const resolved = await frontWindow(client([element("Inbox"), draft]), sources([7, "Inbox"], [8, "Draft"]), 0);
    expect(resolved).toMatchObject({ windowId: 8, pid: 59103, app: "Electron", title: "Draft", element: draft });

    await expect(frontWindow(client([draft]), sources([8, "Draft"], [9, "Draft"]), 0)).rejects.toThrow(/Several windows/u);
    await expect(frontWindow(client([draft]), sources([7, "Inbox"]), 0)).rejects.toThrow(/cannot be recorded/u);
    await expect(frontWindow(client([]), sources(), 0)).rejects.toThrow(/no window in front/u);
    await expect(frontWindow(client([draft], null), sources(), 0)).rejects.toThrow(/No app/u);
  });

  it("captures a window named by its number, and only one that is open", async () => {
    const resolved = await namedWindow({ windowId: 35210, pid: 59103 }, client([element("E18 test window")]), sources([35210, "E18 test window"]));
    expect(resolved).toMatchObject({ windowId: 35210, title: "E18 test window", app: "Electron" });
    expect(resolved.element?.name).toBe("E18 test window");

    const plain = await namedWindow({ windowId: 35210, pid: 59103 }, undefined, sources([35210, "E18 test window"]), async () => "Electron Helper");
    expect(plain).toMatchObject({ app: "Electron Helper" });
    expect(plain.element).toBeUndefined();

    await expect(namedWindow({ windowId: 1, pid: 59103 }, undefined, sources([35210, "x"]))).rejects.toThrow(/not open/u);
    await expect(namedWindow({ windowId: 0, pid: 59103 }, undefined, sources())).rejects.toThrow(/one window/u);
  });

  it("puts the picture and the window's tree together, or says why the tree is missing", async () => {
    const take = vi.fn(async () => ({ url: "data:image/png;base64,QUJD", width: 800, height: 600 }));
    const resolved = { windowId: 35210, pid: 59103, app: "Electron", title: "E18 test window", element: element("E18 test window") };

    const full = await captureResolved(resolved, { accessibility: true, trusted: true, take, now: () => 1_000 });
    expect(take).toHaveBeenCalledWith(35210);
    expect(full).toMatchObject({ app: "Electron", capturedAt: 1_000, image: { data: "QUJD", mimeType: "image/png", width: 800, height: 600 } });
    expect(full.accessibility?.root.children[0]).toMatchObject({ role: "button", name: "Press me", bounds: { x: 100, y: 100, width: 100, height: 40 } });

    expect(await captureResolved(resolved, { accessibility: true, trusted: false, take })).toMatchObject({ accessibilityNote: expect.stringMatching(/Accessibility/u) });
    expect((await captureResolved(resolved, { accessibility: false, trusted: true, take })).accessibility).toBeUndefined();
    expect(await captureResolved({ ...resolved, element: undefined }, { accessibility: true, trusted: true, take })).toMatchObject({ accessibilityNote: expect.stringMatching(/did not describe/u) });
  });

  it("never records without the Screen Recording permission, and never lists windows to find out", async () => {
    electron.systemPreferences.getMediaAccessStatus.mockReturnValue("not-determined");
    const { half: window } = half();
    await expect(window.handle("capture", { target: { windowId: 35210, pid: 59103 }, accessibility: true })).rejects.toThrow(/Screen Recording/u);
    expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(electron.WebContentsView).not.toHaveBeenCalled();
  });

  it("needs Accessibility to know which window is in front", async () => {
    electron.systemPreferences.isTrustedAccessibilityClient.mockReturnValue(false);
    const { half: window } = half(async () => ({}));
    await expect(window.handle("capture", { accessibility: true })).rejects.toThrow(/Accessibility/u);
  });

  it("registers one shortcut at a time and lets it go when told or disposed", async () => {
    const { half: window } = half();
    expect(await window.handle("shortcut", { accelerator: "CommandOrControl+Shift+2", accessibility: true })).toEqual({ registered: "CommandOrControl+Shift+2" });
    expect(electron.globalShortcut.register).toHaveBeenCalledWith("CommandOrControl+Shift+2", expect.any(Function));

    expect(await window.handle("shortcut", { accelerator: "Control+Alt+F19", accessibility: true })).toEqual({ registered: "Control+Alt+F19" });
    expect(electron.globalShortcut.unregister).toHaveBeenCalledWith("CommandOrControl+Shift+2");

    expect(await window.handle("shortcut", { accelerator: null, accessibility: true })).toEqual({});
    expect(electron.globalShortcut.unregister).toHaveBeenCalledWith("Control+Alt+F19");

    await window.handle("shortcut", { accelerator: "CommandOrControl+Shift+2", accessibility: true });
    window.dispose?.();
    expect(electron.globalShortcut.unregister).toHaveBeenLastCalledWith("CommandOrControl+Shift+2");
  });

  it("says when the shortcut is taken or not a shortcut at all", async () => {
    const { half: window } = half();
    electron.globalShortcut.register.mockReturnValue(false);
    expect(await window.handle("shortcut", { accelerator: "CommandOrControl+Shift+2", accessibility: true })).toEqual({ error: expect.stringMatching(/already uses/u) });
    expect(await window.handle("shortcut", { accelerator: "Shift+2", accessibility: true })).toEqual({ error: expect.stringMatching(/not a shortcut/u) });
  });

  it("reports a failed capture to its host when the shortcut fires", async () => {
    electron.systemPreferences.getMediaAccessStatus.mockReturnValue("denied");
    const { half: window, invokeHost } = half();
    await window.handle("shortcut", { accelerator: "CommandOrControl+Shift+2", accessibility: true });
    const fire = (electron.globalShortcut.register.mock.calls[0] as unknown as [string, () => void])[1];
    fire();
    await vi.waitFor(() => expect(invokeHost).toHaveBeenCalledWith("captured", { error: expect.stringMatching(/Screen Recording/u) }));
  });

  it("asks macOS only when the user pressed the button that says so", async () => {
    const { half: window } = half();
    await window.handle("request-access", { kind: "accessibility" });
    expect(electron.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);

    electron.systemPreferences.getMediaAccessStatus.mockReturnValue("denied");
    await window.handle("request-access", { kind: "screen" });
    expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith(expect.stringMatching(/Privacy_ScreenCapture/u));
    await expect(window.handle("screenshot")).rejects.toThrow(/no command/u);
  });
});

it("reports a missing Windows accessibility backend without macOS permission calls", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const { half: window } = half(async () => { throw new Error("Native UI Automation binary missing"); });
    expect(await window.handle("access")).toEqual({ supported: true, screen: "granted", accessibility: "unavailable" });
    await expect(window.handle("capture", { accessibility: true })).rejects.toThrow(/accessibility backend/u);
    expect(electron.systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(electron.systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
    window.dispose?.();
  } finally {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  }
});

it("refuses named Wayland capture before source enumeration or a portal prompt", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
  try {
    const { half: window } = half();
    await expect(window.handle("capture", { target: { windowId: 12, pid: 34 } })).rejects.toThrow(/Wayland/u);
    expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(electron.WebContentsView).not.toHaveBeenCalled();
    window.dispose?.();
  } finally {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  }
});

it("opens one Wayland portal selection only after capture and omits accessibility", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/test-session");
  const load = vi.fn(async () => ({}));
  try {
    const { half: window } = half(load);
    expect(await window.handle("access")).toMatchObject({ captureMode: "picker", screen: "not-determined", accessibility: "unavailable" });
    expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
    electron.desktopCapturer.getSources.mockResolvedValueOnce([{ id: "window:123:0", name: "Selection", thumbnail: { isEmpty: () => false, getSize: () => ({ width: 40, height: 30 }), toPNG: () => Buffer.from("png") } }] as never);
    const capture = await window.handle("capture", { accessibility: true });
    expect(capture).toMatchObject({ app: "Selected source", pid: 0, image: { width: 40, height: 30 }, accessibilityNote: expect.stringMatching(/picker/u) });
    expect(capture).not.toHaveProperty("accessibility");
    expect(load).not.toHaveBeenCalled();
    expect(electron.WebContentsView).not.toHaveBeenCalled();
    window.dispose?.();
  } finally {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  }
});
