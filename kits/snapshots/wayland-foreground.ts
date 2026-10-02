import { app, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { checkNiri, takeNiri } from "./niri.js";
import type { SnapShotBounds, SnapShotCapture, WaylandCaptureState } from "./protocol.js";

export type WaylandBackend = "gnome" | "kde" | "hyprland" | "niri";
export type HelperAction = "install" | "remove";
export interface WaylandWindow { title: string; appName: string; processId: number; bounds: SnapShotBounds; bufferBounds?: SnapShotBounds }
export interface WaylandFrame { capture: SnapShotCapture; window?: WaylandWindow; boundsReliable: boolean }
export type Runner = (executable: string, args: string[]) => Promise<string>;
const MAX_PNG = 16 * 1024 * 1024;
const GNOME_UUID = "snapshots@tau.tbuck.de";
const MARKER = "X-Tau-SnapShots-Helper=true";

export function waylandBackend(env: NodeJS.ProcessEnv): WaylandBackend | undefined {
  if (env.FLATPAK_ID || env.SNAP || !(env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY)) return undefined;
  const desktops = env.XDG_CURRENT_DESKTOP?.toLowerCase().split(":") ?? [];
  if (desktops.includes("niri") && env.NIRI_SOCKET && isAbsolute(env.NIRI_SOCKET)) return "niri";
  if (desktops.includes("hyprland") && env.HYPRLAND_INSTANCE_SIGNATURE) return "hyprland";
  if (desktops.includes("kde")) return "kde";
  if (desktops.includes("gnome")) return "gnome";
  return undefined;
}

export const runHelper: Runner = (executable, args) => new Promise((resolve, reject) => {
  const timeout = args[0] === "capture" || args[1] === "capture" ? 20_000 : 5_000;
  execFile(executable, args, { timeout, maxBuffer: 128 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr.trim() || error.message).slice(0, 1000), { cause: error }));
    else resolve(stdout);
  });
});

async function regularFile(path: string): Promise<Buffer | undefined> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Capture helper files must be regular files, without symbolic links.");
  if (stat.size > 32 * 1024 * 1024) throw new Error("The capture helper file is too large.");
  return readFile(path);
}

/** Refuse symlinked install parents before any write or recursive removal. */
async function safeDirectory(path: string, create: boolean): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Capture helper locations must be absolute.");
  const parent = dirname(path);
  if (parent !== path) await safeDirectory(parent, create);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Capture helper directories must not be symbolic links.");
  if (!stat && create) await mkdir(path, { mode: 0o700 });
}

export function kdeDesktopEntry(executable: string): string {
  if (/[\r\n\0]/u.test(executable)) throw new Error("Invalid capture helper path.");
  // Desktop entries decode string escapes before parsing the quoted Exec argument.
  const escaped = executable.replace(/[\\"`$]/gu, "\\$&").replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll("\t", "\\t");
  const quoted = `"${escaped}"`;
  return `[Desktop Entry]\nType=Application\nName=Tau SnapShots\nNoDisplay=true\nExec=${quoted} check\nX-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2\n${MARKER}\n`;
}

export async function readCapturePng(path: string): Promise<Buffer> {
  // The descriptor fixes identity between size checks and reads; never follow a compositor-created link.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 24 || stat.size > MAX_PNG) throw new Error("The compositor returned an invalid or oversized window image.");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    const png = buffer.subarray(0, bytes);
    if (png.length !== stat.size || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString("ascii", 12, 16) !== "IHDR") throw new Error("The compositor did not return a PNG image.");
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || width > 32768 || height > 32768 || width * height > 64 * 1024 * 1024) throw new Error("The compositor returned an oversized window image.");
    return png;
  } finally { await file.close(); }
}

export function decodeWaylandWindow(value: unknown): WaylandWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const w = value as WaylandWindow;
  if (!w || typeof w.title !== "string" || typeof w.appName !== "string" || !Number.isSafeInteger(w.processId) || w.processId < 0 ||
    !w.bounds || ![w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height].every(Number.isFinite) || w.bounds.width <= 0 || w.bounds.height <= 0)
    throw new Error("The compositor returned invalid window metadata.");
  if (w.bufferBounds && (![w.bufferBounds.x, w.bufferBounds.y, w.bufferBounds.width, w.bufferBounds.height].every(Number.isFinite) || w.bufferBounds.width <= 0 || w.bufferBounds.height <= 0)) throw new Error("The compositor returned invalid window buffer metadata.");
  return { title: w.title.slice(0, 1000), appName: w.appName.slice(0, 255), processId: w.processId, bounds: w.bounds, ...(w.bufferBounds ? { bufferBounds: w.bufferBounds } : {}) };
}

/** Crop only a window's own buffer, including CSD padding, never pixels from a monitor capture. */
export function windowPixelCrop(window: WaylandWindow | undefined, size: { width: number; height: number }): SnapShotBounds | undefined {
  if (!window?.bufferBounds) return undefined;
  const source = window.bufferBounds, frame = window.bounds;
  const scaleX = size.width / source.width, scaleY = size.height / source.height;
  const x = Math.round((frame.x - source.x) * scaleX), y = Math.round((frame.y - source.y) * scaleY);
  const right = Math.round((frame.x + frame.width - source.x) * scaleX), bottom = Math.round((frame.y + frame.height - source.y) * scaleY);
  if (x < 0 || y < 0 || right > size.width || bottom > size.height || right <= x || bottom <= y) throw new Error("The window frame does not fit its captured buffer.");
  return { x, y, width: right - x, height: bottom - y };
}

export interface WaylandOptions {
  environment?: NodeJS.ProcessEnv;
  bundle?: string;
  dataHome?: string;
  run?: Runner;
  checkNiri?: typeof checkNiri;
  takeNiri?: typeof takeNiri;
  now?: () => number;
  /** Production decodes and resizes through Electron; tests may inject a deterministic decoder. */
  image?: (png: Buffer) => { png: Buffer; width: number; height: number };
}

/** Session discovery and helper installation never capture a window or open a portal. */
export class WaylandForeground {
  readonly backend: WaylandBackend | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bundle: string;
  private readonly dataHome: string;
  private readonly run: Runner;
  constructor(private readonly options: WaylandOptions = {}) {
    this.env = options.environment ?? process.env;
    this.backend = waylandBackend(this.env);
    // Window halves ship as CJS beside the copied helper assets. No executable is taken from PATH.
    this.bundle = options.bundle ?? join(typeof __dirname === "string" ? __dirname : join(app.getAppPath(), "dist-kits", "tau.snapshots"), "wayland-helpers");
    this.dataHome = options.dataHome ?? this.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    this.run = options.run ?? runHelper;
  }

  private executable(): string { return join(this.dataHome, "tau", "snapshots", `tau-${this.backend}-snapshot`); }
  private desktop(): string { return join(this.dataHome, "applications", "de.tbuck.Tau.SnapShots.desktop"); }
  private extension(): string { return join(this.dataHome, "gnome-shell", "extensions", GNOME_UUID); }

  async state(): Promise<WaylandCaptureState> {
    const backend = this.backend;
    if (!backend) return { status: "unavailable", message: this.env.FLATPAK_ID || this.env.SNAP ? "Sandboxed sessions use the desktop source picker." : "This desktop uses the manual source picker." };
    try {
      if (backend === "niri") {
        await (this.options.checkNiri ?? checkNiri)(this.env.NIRI_SOCKET!);
        return { backend, status: "ready", message: "Niri focused window capture is ready. Niri also copies each capture to the system clipboard." };
      }
      if (backend === "gnome") {
        const installed = await regularFile(join(this.extension(), "extension.js"));
        if (!installed) return { backend, status: "not-installed", message: "Install and enable the GNOME Shell extension to allow focused window capture." };
        const bundle = await regularFile(join(this.bundle, "gnome", "extension.js"));
        const metadata = await regularFile(join(this.extension(), "metadata.json"));
        const expected = await regularFile(join(this.bundle, "gnome", "metadata.json"));
        if (!bundle || !expected) throw new Error("This build is missing the GNOME capture extension.");
        const service = await regularFile(join(this.extension(), "capture-service.js"));
        const expectedService = await regularFile(join(this.bundle, "gnome", "capture-service.js"));
        if (!expectedService) throw new Error("This build is missing the GNOME capture extension.");
        if (!installed.equals(bundle) || !metadata?.equals(expected) || !service?.equals(expectedService)) return { backend, status: "update-required", message: "Update the GNOME capture extension to continue." };
        const capabilities = JSON.parse(await this.run("python3", [join(this.bundle, "gnome", "client.py"), "check"])) as { version?: unknown };
        if (capabilities.version !== 1) throw new Error("The GNOME extension is disabled or uses an unsupported version. Enable Tau SnapShots in Extensions, or log out and back in after installing.");
      } else {
        const installed = await regularFile(this.executable());
        if (!installed) return { backend, status: "not-installed", message: `Install the ${backend === "kde" ? "KDE" : "Hyprland"} helper to allow focused window capture.` };
        const bundle = await regularFile(join(this.bundle, `tau-${backend}-snapshot`));
        if (!bundle) throw new Error(`This build is missing the ${backend} capture helper.`);
        if (!installed.equals(bundle)) return { backend, status: "update-required", message: "Update the capture helper to continue." };
        if (backend === "kde" && !(await regularFile(this.desktop()))?.equals(Buffer.from(kdeDesktopEntry(this.executable())))) throw new Error("KDE capture permission is not registered. Reinstall the helper.");
        await this.run(this.executable(), ["check"]);
      }
      return { backend, status: "ready", message: "Focused window capture is ready. Use the source picker if a window cannot be captured." };
    } catch (error) { return { backend, status: "error", message: error instanceof Error ? error.message : String(error) }; }
  }

  async setup(action: HelperAction): Promise<WaylandCaptureState> {
    if (action !== "install" && action !== "remove") throw new Error("Choose install or remove for the capture helper.");
    if (!this.backend || this.backend === "niri") throw new Error("This desktop does not need an installable capture helper.");
    if (!isAbsolute(this.dataHome)) throw new Error("XDG_DATA_HOME must be an absolute path.");
    if (this.backend === "gnome") {
      const destination = this.extension();
      await safeDirectory(destination, action === "install");
      const metadata = await regularFile(join(destination, "metadata.json"));
      if (metadata && JSON.parse(metadata.toString()).uuid !== GNOME_UUID) throw new Error("Another extension owns the capture helper directory.");
      for (const name of ["extension.js", "capture-service.js", "metadata.json"]) await regularFile(join(destination, name));
      if (action === "remove") {
        await this.run("gnome-extensions", ["disable", GNOME_UUID]);
        for (const name of ["extension.js", "capture-service.js", "metadata.json"]) await rm(join(destination, name), { force: true });
      } else {
        const version = await this.run("gnome-shell", ["--version"]);
        if (!/GNOME Shell (?:45|46|47|48|49|50)(?:\.|\s|$)/u.test(version)) throw new Error("This extension supports GNOME Shell 45 through 50.");
        for (const name of ["extension.js", "capture-service.js", "metadata.json"]) {
          const content = await regularFile(join(this.bundle, "gnome", name));
          if (!content) throw new Error("This build is missing the GNOME capture extension.");
          await this.installFile(join(destination, name), content, 0o600);
        }
        // GNOME may discover a new extension only after the next session login.
        await this.run("gnome-extensions", ["enable", GNOME_UUID]).catch(() => undefined);
      }
    } else {
      const executable = this.executable();
      await safeDirectory(dirname(executable), action === "install");
      await regularFile(executable);
      if (this.backend === "kde") {
        await safeDirectory(dirname(this.desktop()), action === "install");
        const entry = await regularFile(this.desktop());
        if (entry && !entry.toString().split("\n").includes(MARKER)) throw new Error("Another application owns the capture helper desktop entry.");
      }
      if (action === "remove") {
        await rm(executable, { force: true });
        if (this.backend === "kde") await rm(this.desktop(), { force: true });
      } else {
        const bundle = await regularFile(join(this.bundle, `tau-${this.backend}-snapshot`));
        if (!bundle) throw new Error("This build is missing the native capture helper. Use the manual source picker.");
        await this.installFile(executable, bundle, 0o700);
        if (this.backend === "kde") await this.installFile(this.desktop(), Buffer.from(kdeDesktopEntry(executable)), 0o600);
      }
      if (this.backend === "kde") {
        await this.run("kbuildsycoca6", ["--noincremental"]);
        await this.run("systemd-run", ["--user", "--quiet", "--wait", "--collect", "--pipe", "--service-type=exec", "kbuildsycoca6", "--noincremental"]).catch(() => undefined);
      }
    }
    return this.state();
  }

  private async installFile(destination: string, contents: Buffer, mode: number): Promise<void> {
    const staging = await mkdtemp(join(dirname(destination), ".snapshot-install-"));
    try {
      const file = join(staging, "asset");
      await writeFile(file, contents, { flag: "wx", mode });
      await rename(file, destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async capture(checkedState?: WaylandCaptureState): Promise<WaylandFrame> {
    const state = checkedState ?? await this.state();
    if (state.status !== "ready") throw new Error(`${state.message} Choose a window or display in Settings to use the manual picker.`);
    const directory = await mkdtemp(join(tmpdir(), "tau-wayland-snapshot-"));
    await chmod(directory, 0o700);
    try {
      let window: WaylandWindow | undefined;
      if (this.backend === "niri") {
        const w = await (this.options.takeNiri ?? takeNiri)(this.env.NIRI_SOCKET!, join(directory, "capture.png"));
        if (w) window = { title: w.title ?? "", appName: w.app_id ?? "Application", processId: w.pid ?? 0, bounds: { x: 0, y: 0, width: w.layout.window_size[0], height: w.layout.window_size[1] } };
      } else {
        const output = this.backend === "gnome"
          ? await this.run("python3", [join(this.bundle, "gnome", "client.py"), "capture", directory])
          : await this.run(this.executable(), ["capture", directory]);
        window = decodeWaylandWindow((JSON.parse(output) as { window?: unknown }).window);
      }
      const png = await readCapturePng(join(directory, "capture.png"));
      const frame = this.options.image ? this.options.image(png) : (() => {
        let image = nativeImage.createFromBuffer(png);
        if (image.isEmpty()) throw new Error("The compositor returned an unreadable window image.");
        const crop = windowPixelCrop(window, image.getSize());
        if (crop) image = image.crop(crop);
        const source = image.getSize();
        const resized = source.width > 1920 ? image.resize({ width: 1920 }) : image;
        return { png: resized.toPNG(), ...resized.getSize() };
      })();
      if (frame.png.length > MAX_PNG) throw new Error("The window image is too large.");
      return { capture: { app: window?.appName || "Captured window", title: window?.title ?? "", pid: window?.processId ?? 0,
        capturedAt: (this.options.now ?? Date.now)(), image: { data: frame.png.toString("base64"), mimeType: "image/png", width: frame.width, height: frame.height } },
        ...(window ? { window } : {}), boundsReliable: this.backend !== "niri" };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
