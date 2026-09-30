import { desktopCapturer, globalShortcut, shell, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import { WindowCapture, captureWindowOnce, windowSourceId, type WindowCaptureOptions } from "../_window-capture/capture.js";
import { matchWindow, readElementTree, type AccessibleElement } from "./accessibility.js";
import {
  ACCESSIBILITY_PACKAGE,
  CAPTURED_COMMAND,
  type ArmInput,
  type Permission,
  type PermissionKind,
  type ShortcutState,
  type SnapShotAccess,
  type SnapShotAccessibility,
  type SnapShotCapture,
  type SnapShotTarget,
} from "./protocol.js";
import { isAccelerator } from "./shortcut.js";
import { captureWaylandWindow } from "./wayland.js";
import { WaylandForeground, type WaylandFrame } from "./wayland-foreground.js";

const SETTINGS_PANES: Record<PermissionKind, string> = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

/** PNG keeps a window's text legible; 1920 px wide is enough to read it and small enough to send. */
const STILL: WindowCaptureOptions = { partition: "tau-snapshots-capture", maxWidth: 1_920, mimeType: "image/png", frameRate: 5 };
const ACCESSIBILITY_BUDGET_MS = 3_000;
/** A key held down repeats; one press is one capture. */
const SHORTCUT_COOLDOWN_MS = 400;

/** What this kit reads of the accessibility client (`@crowecawcaw/xa11y`). */
interface AccessibleWindow extends AccessibleElement {
  readonly name: string | null;
  readonly active: boolean;
}
interface AccessibleApp {
  readonly name: string;
  readonly pid: number | null;
  windows(): Promise<AccessibleWindow[]>;
}
export interface AccessibilityClient {
  App: {
    foreground(options?: { timeout?: number }): Promise<AccessibleApp>;
    byPid(pid: number, options?: { timeout?: number }): Promise<AccessibleApp>;
  };
}

interface WindowSource { id: string; name: string }

/** The window-numbered sources the system would let Tau record, titles only (no thumbnails are drawn). */
async function windowSources(): Promise<WindowSource[]> {
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  return sources.map((source) => ({ id: source.id, name: source.name }));
}

export function windowIdOfSource(id: string): number | undefined {
  const match = /^window:(\d+):/u.exec(id);
  return match ? Number(match[1]) : undefined;
}

/** Reads platform availability without listing windows or raising a permission prompt. */
export function readAccess(
  platform: string = process.platform,
  screen: () => string = () => systemPreferences.getMediaAccessStatus("screen"),
  trusted: () => boolean = () => systemPreferences.isTrustedAccessibilityClient(false),
  environment: NodeJS.ProcessEnv = process.env,
): SnapShotAccess {
  if (platform === "win32") return { supported: true, screen: "granted", accessibility: "granted" };
  if (platform === "linux") {
    // Portal availability needs the user's session bus. The chooser is opened
    // only on a capture action, never while checking access or arming a key.
    const wayland = environment.XDG_SESSION_TYPE === "wayland" || Boolean(environment.WAYLAND_DISPLAY);
    return { supported: true,
      ...(wayland ? { captureMode: "picker" as const } : {}),
      screen: wayland ? environment.DBUS_SESSION_BUS_ADDRESS ? "not-determined" : "unavailable" : environment.DISPLAY ? "granted" : "unavailable",
      accessibility: !wayland && environment.DBUS_SESSION_BUS_ADDRESS ? "granted" : "unavailable" };
  }
  if (platform !== "darwin") return { supported: false, screen: "unavailable", accessibility: "unavailable" };
  const answer = screen();
  const known: Permission[] = ["granted", "denied", "not-determined", "restricted"];
  return {
    supported: true,
    screen: known.includes(answer as Permission) ? answer as Permission : "unavailable",
    // The system says only yes or no here; "no" may still mean it never asked.
    accessibility: trusted() ? "granted" : "denied",
  };
}

async function readWindows(app: AccessibleApp, retryMs = 300): Promise<AccessibleWindow[]> {
  const windows = await app.windows();
  if (windows.length > 0) return windows;
  // Chromium builds its accessibility tree on the first question and answers it empty.
  await new Promise((resolve) => setTimeout(resolve, retryMs));
  return await app.windows();
}

function executableName(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (process.platform === "win32") return resolve(undefined);
    execFile("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 2_000 }, (error, stdout) => resolve(error ? undefined : basename(stdout.trim()) || undefined));
  });
}

export interface ResolvedWindow {
  windowId: number;
  pid: number;
  app: string;
  title: string;
  element?: AccessibleWindow;
}

/**
 * The window in front: the foreground app's active window, found among the
 * recordable windows by its title. A title several windows share cannot say
 * which one is meant, so that is refused rather than guessed.
 */
export async function frontWindow(client: AccessibilityClient, sources: () => Promise<WindowSource[]>, retryMs?: number): Promise<ResolvedWindow> {
  const app = await client.App.foreground({ timeout: 0 });
  if (!app.pid) throw new Error("No app is in front.");
  const window = matchWindow(await readWindows(app, retryMs), "");
  if (!window) throw new Error(`${app.name} has no window in front.`);
  const title = (window.name ?? "").trim();
  const matches = (await sources()).filter((source) => source.name.trim() === title && windowIdOfSource(source.id) !== undefined);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `The window of ${app.name} cannot be recorded.` : `Several windows are titled “${title}”; bring the one you mean to the front alone.`);
  return { windowId: windowIdOfSource(matches[0]!.id)!, pid: app.pid, app: app.name, title, element: window };
}

/** A window the caller named by its number and process; its title comes from the system, its element from the app. */
export async function namedWindow(target: SnapShotTarget, client: AccessibilityClient | undefined, sources: () => Promise<WindowSource[]>, appName: (pid: number) => Promise<string | undefined> = executableName): Promise<ResolvedWindow> {
  const source = windowSourceId(target.windowId);
  if (!Number.isInteger(target.pid) || target.pid <= 0) throw new Error("Name the window's process too.");
  const found = (await sources()).find((entry) => entry.id === source || entry.id.startsWith(`window:${target.windowId}:`));
  if (!found) throw new Error("That window is not open, or Tau may not record it.");
  const title = found.name.trim();
  const app = client ? await client.App.byPid(target.pid, { timeout: 0 }).catch(() => undefined) : undefined;
  const element = app ? matchWindow(await readWindows(app).catch(() => []), title) : undefined;
  return { windowId: target.windowId, pid: target.pid, app: app?.name || await appName(target.pid) || "Window", title, ...(element ? { element } : {}) };
}

/** Captures one resolved window: its picture and, when asked and allowed, its accessibility tree. */
export async function captureResolved(
  resolved: ResolvedWindow,
  options: { accessibility: boolean; trusted: boolean; take: (windowId: number) => Promise<{ url: string; width: number; height: number }>; now?: () => number },
): Promise<SnapShotCapture> {
  const now = options.now ?? Date.now;
  const capturedAt = now();
  const frame = await options.take(resolved.windowId);
  const comma = frame.url.indexOf(",");
  const mimeType = /^data:([^;,]+)/u.exec(frame.url)?.[1] ?? "image/png";
  let accessibility: SnapShotAccessibility | undefined;
  let accessibilityNote: string | undefined;
  if (options.accessibility) {
    const bounds = resolved.element ? (() => { try { return resolved.element.bounds; } catch { return null; } })() : null;
    if (!options.trusted) accessibilityNote = "Tau is not allowed to read other apps (Accessibility).";
    else if (!resolved.element || !bounds) accessibilityNote = "The app did not describe this window.";
    else {
      try {
        accessibility = await readElementTree(resolved.element, bounds, { width: frame.width, height: frame.height }, { deadline: now() + ACCESSIBILITY_BUDGET_MS, now });
      } catch {
        accessibilityNote = "The app did not answer in time.";
      }
    }
  }
  return {
    app: resolved.app,
    title: resolved.title,
    pid: resolved.pid,
    capturedAt,
    image: { data: frame.url.slice(comma + 1), mimeType, width: frame.width, height: frame.height },
    ...(accessibility ? { accessibility } : {}),
    ...(accessibilityNote ? { accessibilityNote } : {}),
  };
}

/** AT-SPI bounds must agree with compositor coordinates before attaching text to the image. */
export async function addWaylandAccessibility(frame: WaylandFrame, client: AccessibilityClient | undefined, now = Date.now): Promise<SnapShotCapture> {
  const capture = frame.capture;
  const window = frame.window;
  if (!client || !window?.processId || !frame.boundsReliable) return { ...capture, accessibilityNote: "The compositor did not provide reliable accessibility coordinates for this window, or AT-SPI is unavailable." };
  try {
    const app = await client.App.byPid(window.processId, { timeout: 0 });
    const matches = (await readWindows(app)).filter((element) => element.name?.trim() === window.title.trim());
    const element = matches.length === 1 ? matches[0] : undefined;
    const bounds = element?.bounds;
    if (!element || !bounds || !(["x", "y", "width", "height"] as const).every((key) => Math.abs(bounds[key] - window.bounds[key]) <= 2))
      return { ...capture, accessibilityNote: "The app's window and coordinates did not match the captured window. Accessibility text was omitted." };
    const accessibility = await readElementTree(element, window.bounds, capture.image, { deadline: now() + ACCESSIBILITY_BUDGET_MS, now });
    return { ...capture, accessibility };
  } catch { return { ...capture, accessibilityNote: "The app did not provide accessibility text for this window." }; }
}

/**
 * SnapShots' window half: the global shortcut, the permissions and the
 * capture itself, all where the user's windows are. Foreground capture records
 * one window. The explicit Wayland portal chooser may also select a display.
 */
export default function activate(context: WindowExtensionContext): WindowExtension {
  let wayland: WaylandForeground | undefined;
  const foreground = () => wayland ??= new WaylandForeground();
  const accessNow = async (): Promise<SnapShotAccess> => {
    const access = readAccess();
    if (access.captureMode === "picker") {
      access.wayland = await foreground().state();
      if (access.wayland.status === "ready") {
        access.captureMode = "foreground";
        access.screen = "granted";
        access.accessibility = process.env.DBUS_SESSION_BUS_ADDRESS ? "granted" : "unavailable";
      }
    }
    return access;
  };
  let client: Promise<AccessibilityClient | undefined> | undefined;
  const accessibilityClient = (): Promise<AccessibilityClient | undefined> => client ??= (context.loadDependency
    ? context.loadDependency(ACCESSIBILITY_PACKAGE).then((module) => module as AccessibilityClient, (error: unknown) => {
      context.log("accessibility.unavailable", String(error));
      return undefined;
    })
    : Promise.resolve(undefined));

  let armed: ArmInput | undefined;
  let registered: string | undefined;
  let busy = false;
  let last = 0;

  const capture = async (target: SnapShotTarget | undefined, accessibility: boolean, picker = false): Promise<SnapShotCapture> => {
    const access = readAccess();
    if (!access.supported) throw new Error("SnapShots are available on macOS, Windows and Linux.");
    if (access.captureMode === "picker") {
      if (target) throw new Error("A client window number cannot identify a Wayland window. Capture the focused window or use the desktop picker.");
      const backend = foreground();
      const state = !picker ? await backend.state() : undefined;
      if (state?.status === "ready") {
        // A denied or failed native capture stays a failure. The manual chooser remains an explicit action.
        const frame = await backend.capture(state);
        return accessibility ? addWaylandAccessibility(frame, process.env.DBUS_SESSION_BUS_ADDRESS ? await accessibilityClient() : undefined) : frame.capture;
      }
      if (access.screen === "unavailable") throw new Error("The Wayland desktop picker needs a session D-Bus, xdg-desktop-portal and PipeWire.");
      return captureWaylandWindow();
    }
    // Recording asks the system for permission on its first try; only the Settings button may do that.
    if (access.screen !== "granted") throw new Error(process.platform === "darwin"
      ? "Tau may not record windows yet. Allow Screen Recording for Tau in System Settings."
      : "Window capture is unavailable in this desktop session. On Linux, use an X11 session; Wayland does not expose foreground window capture without a portal chooser.");
    const trusted = access.accessibility === "granted";
    const ax = trusted ? await accessibilityClient() : undefined;
    let resolved: ResolvedWindow;
    if (target) resolved = await namedWindow(target, ax, windowSources);
    else {
      if (!ax) throw new Error(process.platform === "darwin"
        ? "Tau needs Accessibility to know which window is in front. Allow it in System Settings."
        : "Tau cannot read the foreground window. Check that the accessibility backend is installed and available; Linux needs the session D-Bus and AT-SPI service, and Windows cannot read an elevated app from an unelevated Tau.");
      resolved = await frontWindow(ax, windowSources);
    }
    return captureResolved(resolved, {
      accessibility,
      trusted: Boolean(ax),
      take: (windowId) => captureWindowOnce(new WindowCapture(windowId, STILL)),
    });
  };

  const fire = (): void => {
    const now = Date.now();
    if (busy || now - last < SHORTCUT_COOLDOWN_MS || !armed) return;
    busy = true;
    last = now;
    void capture(undefined, armed.accessibility)
      .then((result) => context.invokeHost(CAPTURED_COMMAND, { capture: result }))
      .catch((error: unknown) => context.invokeHost(CAPTURED_COMMAND, { error: error instanceof Error ? error.message : String(error) }))
      .catch((error: unknown) => context.log("capture.unreported", String(error)))
      .finally(() => { busy = false; });
  };

  const release = (): void => {
    if (registered) globalShortcut.unregister(registered);
    registered = undefined;
  };

  const arm = (input: ArmInput): ShortcutState => {
    const accelerator = input.accelerator;
    if (accelerator === registered && accelerator) {
      armed = input;
      return { registered };
    }
    release();
    armed = undefined;
    if (!accelerator) return {};
    if (!isAccelerator(accelerator)) return { error: `“${accelerator}” is not a shortcut Tau can register.` };
    if (!readAccess().supported) return { error: "SnapShots are available on macOS, Windows and Linux." };
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, fire);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!ok) return { error: readAccess().captureMode === "picker"
      ? "Your desktop could not register this global shortcut. Check the desktop's shortcut permission and portal backend, or use capture in Settings."
      : "Another app or the system already uses this shortcut." };
    registered = accelerator;
    armed = input;
    return { registered };
  };

  return {
    async handle(command: string, input?: unknown): Promise<unknown> {
      switch (command) {
        case "access":
          {
            const access = await accessNow();
            if (process.platform !== "darwin" && access.accessibility === "granted" && !await accessibilityClient()) access.accessibility = "unavailable";
            return access;
          }
        case "request-access": {
          const kind = (input as { kind?: unknown } | undefined)?.kind;
          const access = readAccess();
          if (!access.supported || process.platform !== "darwin") return access;
          if (kind === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
          // Listing windows is what raises the system's Screen Recording question the first time.
          else if (kind === "screen" && access.screen === "not-determined") await windowSources().catch(() => []);
          else if (kind === "screen") await shell.openExternal(SETTINGS_PANES.screen);
          return readAccess();
        }
        case "open-settings": {
          const kind = (input as { kind?: unknown } | undefined)?.kind;
          if (process.platform === "darwin" && (kind === "screen" || kind === "accessibility")) await shell.openExternal(SETTINGS_PANES[kind]);
          return undefined;
        }
        case "shortcut":
          return arm(input as ArmInput);
        case "wayland-helper": {
          if (readAccess().captureMode !== "picker") throw new Error("Capture helpers are available only in a Wayland desktop session.");
          const action = (input as { action?: unknown } | undefined)?.action;
          if (action !== "install" && action !== "remove") throw new Error("Choose install or remove for the capture helper.");
          await foreground().setup(action);
          return accessNow();
        }
        case "capture": {
          const { target, accessibility, picker } = (input ?? {}) as { target?: SnapShotTarget; accessibility?: boolean; picker?: boolean };
          return capture(target, accessibility !== false, picker === true);
        }
        default:
          throw new Error(`SnapShots' window half has no command "${command}".`);
      }
    },
    dispose: () => {
      release();
      armed = undefined;
    },
  };
}
