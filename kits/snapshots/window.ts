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

/** macOS only; `isTrustedAccessibilityClient(false)` answers without asking. */
export function readAccess(
  platform: string = process.platform,
  screen: () => string = () => systemPreferences.getMediaAccessStatus("screen"),
  trusted: () => boolean = () => systemPreferences.isTrustedAccessibilityClient(false),
): SnapShotAccess {
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

/**
 * SnapShots' window half: the global shortcut, the permissions and the
 * capture itself, all where the user's windows are. It records one window,
 * never a screen, and asks the system for nothing unless the user pressed a
 * button that says so.
 */
export default function activate(context: WindowExtensionContext): WindowExtension {
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

  const capture = async (target: SnapShotTarget | undefined, accessibility: boolean): Promise<SnapShotCapture> => {
    const access = readAccess();
    if (!access.supported) throw new Error("SnapShots need macOS for now.");
    // Recording asks the system for permission on its first try; only the Settings button may do that.
    if (access.screen !== "granted") throw new Error("Tau may not record windows yet. Allow Screen Recording for Tau in System Settings.");
    const trusted = access.accessibility === "granted";
    const ax = trusted ? await accessibilityClient() : undefined;
    let resolved: ResolvedWindow;
    if (target) resolved = await namedWindow(target, ax, windowSources);
    else {
      if (!ax) throw new Error("Tau needs Accessibility to know which window is in front. Allow it in System Settings.");
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
    if (!readAccess().supported) return { error: "SnapShots need macOS for now." };
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, fire);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!ok) return { error: "Another app or the system already uses this shortcut." };
    registered = accelerator;
    armed = input;
    return { registered };
  };

  return {
    async handle(command: string, input?: unknown): Promise<unknown> {
      switch (command) {
        case "access":
          return readAccess();
        case "request-access": {
          const kind = (input as { kind?: unknown } | undefined)?.kind;
          const access = readAccess();
          if (!access.supported) return access;
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
        case "capture": {
          const { target, accessibility } = (input ?? {}) as { target?: SnapShotTarget; accessibility?: boolean };
          return capture(target, accessibility !== false);
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
