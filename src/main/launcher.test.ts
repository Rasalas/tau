import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  switches: new Map<string, string>(),
  appendSwitch: vi.fn(),
  execFileSync: vi.fn(),
  readSource: vi.fn(),
  stopped: new Error("Stop before loading the workbench"),
}));

vi.mock("electron", () => ({ app: {
  commandLine: {
    getSwitchValue: (name: string) => startup.switches.get(name) ?? "",
    appendSwitch: startup.appendSwitch,
  },
  getPath: () => "/test/app-data",
  setActivationPolicy: vi.fn(),
} }));
vi.mock("node:child_process", () => ({ execFileSync: startup.execFileSync }));
vi.mock("./compile-cache.js", () => ({}));
vi.mock("./app-identity.js", () => ({ appIdentity: () => ({ userDataFolder: "test" }) }));
vi.mock("./workbench-source.js", () => ({ readWorkbenchSourceRoot: startup.readSource }));

const releases = [
  ["0.48.0", "5ee35f914f921e5696030698e74fb5566a804768"],
  ["0.48.1", "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc"],
  ["0.49.0", "9958d297641b5c84dcff93f9039d80a5ad37ab00"],
  ["0.50.0", "c4a4c341568944bd4fb9cd503558b2de602c0213"],
  ["0.50.1", "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc"],
] as const;
const colorManager = "WaylandWpColorManagerV1";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

function versionOutput(version = "0.49.0", commit: string = releases[2][1], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version, commit, tag: `v${version}`, dirty: false, ...extra });
}

async function launch(): Promise<void> {
  await expect(import("./launcher.js")).rejects.toBe(startup.stopped);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "linux" });
  for (const key of ["TAU_IGNORE_WORKBENCH_SOURCE", "TAU_NO_EXTENSIONS", "TAU_USER_DATA", "XDG_SESSION_DESKTOP", "HYPRLAND_INSTANCE_SIGNATURE"])
    vi.stubEnv(key, "");
  vi.stubEnv("XDG_CURRENT_DESKTOP", "Hyprland");
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
  startup.switches.clear();
  startup.switches.set("ozone-platform", "wayland");
  startup.execFileSync.mockReset().mockReturnValue(versionOutput());
  startup.appendSwitch.mockImplementation((name: string, value: string) => startup.switches.set(name, value));
  startup.readSource.mockImplementation(() => { throw startup.stopped; });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
});

describe("the launcher's early Wayland setup", () => {
  it.each(releases)("disables the color manager on stock Hyprland %s before asynchronous startup", async (version, commit) => {
    startup.execFileSync.mockReturnValue(versionOutput(version, commit));
    await launch();
    expect(startup.appendSwitch).toHaveBeenCalledWith("disable-features", colorManager);
    expect(startup.appendSwitch.mock.invocationCallOrder[0]).toBeLessThan(startup.readSource.mock.invocationCallOrder[0]!);
    expect(startup.execFileSync).toHaveBeenCalledWith("hyprctl", ["version", "-j"], expect.objectContaining({
      encoding: "utf8", timeout: 1000, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"],
    }));
  });

  it("preserves existing disabled features and does not confuse a prefix with the feature", async () => {
    startup.switches.set("disable-features", `Vulkan,${colorManager}Extra`);
    await launch();
    expect(startup.switches.get("disable-features")).toBe(`Vulkan,${colorManager}Extra,${colorManager}`);
  });

  it.each([
    { XDG_CURRENT_DESKTOP: "other:HYPRLAND" },
    { XDG_CURRENT_DESKTOP: "", XDG_SESSION_DESKTOP: "hyprland" },
  ])("recognizes the session's desktop tokens %j", async (env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await launch();
    expect(startup.switches.get("disable-features")).toBe(colorManager);
  });

  it.each([
    ["0.47.2", {}], ["0.51.0", {}], ["0.50.2", {}], ["1.0.0", {}],
    ["0.49", {}], ["0.49.0-rc1", {}],
    ["0.49.0", { dirty: true }], ["0.49.0", { dirty: undefined }],
    ["0.49.0", { tag: "v0.49.0-12-g1234567" }], ["0.49.0", { tag: "" }],
    ["0.49.0", { commit: "unknown" }], ["0.49.0", { commit: releases[0][1] }],
    ["0.49.0", { commit: undefined }],
  ])("leaves version %s with metadata %j unchanged", async (version, extra) => {
    startup.execFileSync.mockReturnValue(versionOutput(version, releases[2][1], extra));
    startup.switches.set("disable-features", "Vulkan");
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
    expect(startup.switches.get("disable-features")).toBe("Vulkan");
  });

  it.each(["not json", "null", "{}", "[]"])("continues startup when the version output is %s", async (output) => {
    startup.execFileSync.mockReturnValue(output);
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
  });

  it("continues startup when hyprctl fails or times out", async () => {
    startup.execFileSync.mockImplementation(() => { throw new Error("hyprctl unavailable"); });
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
  });

  it.each([
    ["enable-features", colorManager],
    ["enable-features", `Vulkan,*${colorManager}<Study.Group:mode/strict`],
    ["disable-features", `Vulkan, ${colorManager}`],
    ["disable-features", `${colorManager}:mode/strict`],
  ])("preserves an explicit %s override %s without probing", async (name, value) => {
    startup.switches.set(name, value);
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
    expect(startup.execFileSync).not.toHaveBeenCalled();
    expect(startup.switches.get(name)).toBe(value);
  });

  it.each(["x11", "headless"])("does not probe on the %s platform", async (ozone) => {
    startup.switches.set("ozone-platform", ozone);
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
    expect(startup.execFileSync).not.toHaveBeenCalled();
  });

  it.each(["", "auto"])("treats the %s platform as Wayland when a Wayland display is there", async (ozone) => {
    startup.switches.set("ozone-platform", ozone);
    await launch();
    expect(startup.appendSwitch).toHaveBeenCalledWith("disable-features", colorManager);
    vi.resetModules(); startup.appendSwitch.mockClear(); startup.execFileSync.mockClear(); startup.switches.delete("disable-features");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
    expect(startup.execFileSync).not.toHaveBeenCalled();
  });

  it("follows an X11 platform hint", async () => {
    startup.switches.delete("ozone-platform");
    startup.switches.set("ozone-platform-hint", "x11");
    await launch();
    expect(startup.execFileSync).not.toHaveBeenCalled();
  });

  it.each(["KDE", "GNOME", "NotHyprland"])("ignores a stale Hyprland signature in %s", async (desktop) => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", desktop);
    vi.stubEnv("XDG_SESSION_DESKTOP", "Hyprland");
    vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "stale");
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
    expect(startup.execFileSync).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"])("does not probe on %s", async (os) => {
    Object.defineProperty(process, "platform", { value: os });
    await launch();
    expect(startup.appendSwitch).not.toHaveBeenCalled();
    expect(startup.execFileSync).not.toHaveBeenCalled();
  });
});
