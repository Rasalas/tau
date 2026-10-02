import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getAppPath: () => "/app" }, nativeImage: {} }));
const { WaylandForeground, decodeWaylandWindow, kdeDesktopEntry, readCapturePng, waylandBackend, windowPixelCrop } = await import("./wayland-foreground.js");
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=", "base64");
const window = { title: "Private document", appName: "Editor", processId: 43, bounds: { x: -1920, y: -200, width: 800, height: 600 } };
async function setup(backend: "gnome" | "kde" | "hyprland" | "niri") {
  // macOS /var is a system symlink. Resolve the test root before testing install path safety.
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-wayland-test-")));
  directories.push(root);
  const dataHome = join(root, "data"), bundle = join(root, "bundle");
  await mkdir(join(bundle, "gnome"), { recursive: true });
  await writeFile(join(bundle, `tau-${backend}-snapshot`), "dedicated executable");
  await writeFile(join(bundle, "gnome", "extension.js"), "extension code");
  await writeFile(join(bundle, "gnome", "capture-service.js"), "capture policy");
  await writeFile(join(bundle, "gnome", "metadata.json"), JSON.stringify({ uuid: "snapshots@tau.tbuck.de" }));
  const run = vi.fn(async (executable: string, args: string[]) => {
    if (executable === "gnome-shell") return "GNOME Shell 50.1";
    if (args.at(-1) === "check" || args[0] === "check") return JSON.stringify({ version: 1 });
    if (args.includes("capture")) {
      await writeFile(join(args.at(-1)!, "capture.png"), png);
      return JSON.stringify({ window });
    }
    return "";
  });
  const options = { dataHome, bundle, run, environment: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: backend === "kde" ? "KDE" : backend, HYPRLAND_INSTANCE_SIGNATURE: "instance", NIRI_SOCKET: "/tmp/test-niri.sock" },
    image: (data: Buffer) => ({ png: data, width: 800, height: 600 }), now: () => 1234 };
  return { root, dataHome, bundle, run, options, capture: new WaylandForeground(options) };
}

it("discovers only the current native compositor and rejects sandbox hints", () => {
  expect(waylandBackend({ XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":1" })).toBeUndefined();
  expect(waylandBackend({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe("gnome");
  expect(waylandBackend({ WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "niri", NIRI_SOCKET: "relative.sock" })).toBeUndefined();
  expect(waylandBackend({ WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE", FLATPAK_ID: "tau" })).toBeUndefined();
});

for (const backend of ["gnome", "kde", "hyprland"] as const) {
  it(`${backend} discovery never installs, captures, opens a picker or raises permissions`, async () => {
    const { capture, run, dataHome } = await setup(backend);
    expect(await capture.state()).toMatchObject({ backend, status: "not-installed" });
    expect(run).not.toHaveBeenCalled();
    expect(await stat(dataHome).catch(() => undefined)).toBeUndefined();
  });
  it(`${backend} installs only on request, captures one native window and removes temporary pixels`, async () => {
    const { capture, run } = await setup(backend);
    expect(await capture.setup("install")).toMatchObject({ status: "ready" });
    run.mockClear();
    const result = await capture.capture();
    expect(result).toMatchObject({ window, boundsReliable: true, capture: { app: "Editor", pid: 43, capturedAt: 1234, image: { width: 800, height: 600 } } });
    const call = run.mock.calls.find(([, args]) => args.includes("capture"))!;
    expect(call).toBeDefined();
    expect(await stat(call[1].at(-1)!).catch(() => undefined)).toBeUndefined();
    await capture.setup("remove");
    expect(await capture.state()).toMatchObject({ status: "not-installed" });
  });
  it(`${backend} refuses modified helpers, denied capture and unsafe install directories`, async () => {
    const { capture, run, dataHome, root } = await setup(backend);
    await capture.setup("install");
    let temporary: string | undefined;
    const defaultRun = run.getMockImplementation()!;
    run.mockImplementation(async (executable, args) => {
      if (args.includes("capture")) { temporary = args.at(-1); await writeFile(join(temporary!, "capture.png"), png); throw new Error("Permission denied"); }
      return defaultRun(executable, args);
    });
    await expect(capture.capture()).rejects.toThrow(/denied/u);
    expect(await stat(temporary!).catch(() => undefined)).toBeUndefined();
    const helper = backend === "gnome" ? join(dataHome, "gnome-shell", "extensions", "snapshots@tau.tbuck.de", "extension.js") : join(dataHome, "tau", "snapshots", `tau-${backend}-snapshot`);
    await writeFile(helper, "changed");
    expect(await capture.state()).toMatchObject({ status: "update-required" });
    await capture.setup("remove");
    const parent = backend === "gnome" ? join(dataHome, "gnome-shell", "extensions", "snapshots@tau.tbuck.de") : join(dataHome, "tau", "snapshots");
    await rm(parent, { recursive: true });
    await symlink(root, parent);
    await expect(capture.setup("install")).rejects.toThrow(/symbolic links/u);
  });
}

it("registers KDE capture permission for the dedicated installed binary and preserves Exec arguments", () => {
  const entry = kdeDesktopEntry('/home/Name with spaces/"$`%/tau-kde-snapshot');
  expect(entry).toContain("X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2\n");
  expect(entry).toContain('Exec="/home/Name with spaces/\\\\"\\\\$\\\\`%%/tau-kde-snapshot" check');
  expect(() => kdeDesktopEntry("/tmp/\nmalicious")).toThrow(/Invalid/u);
});

it("crops GNOME client-side decoration padding in the window buffer at fractional scale and negative monitor coordinates", () => {
  const metadata = { ...window, bounds: { x: -1920, y: -200, width: 800, height: 600 }, bufferBounds: { x: -1940, y: -220, width: 840, height: 640 } };
  expect(windowPixelCrop(metadata, { width: 1260, height: 960 })).toEqual({ x: 30, y: 30, width: 1200, height: 900 });
  expect(windowPixelCrop(window, { width: 1200, height: 900 })).toBeUndefined();
  expect(() => windowPixelCrop({ ...metadata, bounds: { ...metadata.bounds, x: -2000 } }, { width: 1260, height: 960 })).toThrow(/does not fit/u);
});

it("rejects malformed metadata, linked PNGs, oversized decoded images and non-PNG output", async () => {
  const { root } = await setup("gnome");
  expect(decodeWaylandWindow(window)?.bounds.x).toBe(-1920);
  expect(() => decodeWaylandWindow({ ...window, bounds: { ...window.bounds, width: 0 } })).toThrow(/metadata/u);
  const path = join(root, "capture.png"), link = join(root, "linked.png");
  await writeFile(path, png);
  await symlink(path, link);
  await expect(readCapturePng(link)).rejects.toThrow();
  await writeFile(path, Buffer.alloc(32));
  await expect(readCapturePng(path)).rejects.toThrow(/PNG/u);
  const tooBig = Buffer.from(png); tooBig.writeUInt32BE(1_000_000, 16);
  await writeFile(path, tooBig);
  await expect(readCapturePng(path)).rejects.toThrow(/oversized/u);
});

it("uses Niri's exact ID capture and omits unreliable global accessibility coordinates", async () => {
  const { options } = await setup("niri");
  const check = vi.fn(async () => undefined);
  const take = vi.fn(async (_socket, path) => { await writeFile(path, png); return { id: 10, pid: 43, title: "Niri doc", app_id: "Editor", layout: { window_size: [800, 600] as [number, number] } }; });
  const capture = new WaylandForeground({ ...options, checkNiri: check, takeNiri: take });
  expect(await capture.state()).toMatchObject({ status: "ready" });
  expect(take).not.toHaveBeenCalled();
  expect(await capture.capture()).toMatchObject({ boundsReliable: false, capture: { title: "Niri doc", pid: 43 } });
  expect(take.mock.calls[0]![0]).toBe("/tmp/test-niri.sock");
  expect(await stat(take.mock.calls[0]![1]).catch(() => undefined)).toBeUndefined();
});
