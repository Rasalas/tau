import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HostCommandError, type HostCommandCall, type HostExtension, type HostExtensionContext, type RuntimeExtensionFactory } from "tau/host-extension";
import {
  EMPTY_PREVIEW_STATE,
  PREVIEW_HOST_EXTENSION_ID,
  PREVIEW_STATE_EVENT,
  type PreviewAppearance,
  type PreviewBounds,
  type PreviewChord,
  type PreviewDefaults,
  type PreviewDriver,
  type PreviewFrame,
  type PreviewHistoryEntry,
  type PreviewImage,
  type PreviewInputResult,
  type PreviewLiveFrame,
  type PreviewNoWindow,
  type PreviewProfiles,
  type PreviewRecording,
  type PreviewServer,
  type PreviewState,
  type PreviewViewport,
} from "./protocol.js";
import {
  previewAnnotateCollect,
  previewAnnotateEnd,
  previewAnnotateStart,
  previewDescribe,
  previewPickArm,
  previewPickCancel,
  previewPickPoll,
  previewSelector,
  type PreviewAnnotationResult,
  type PreviewAnnotationTool,
  type PreviewPickPoll,
  type PreviewPickedElement,
} from "./page-overlay.js";
import { EVIDENCE_CALLER, previewSecretFocus, type PreviewEvidenceFrame } from "./evidence-frame.js";
import { pickCrop, readAnnotationResult, readPickedElement } from "./picks.js";
import { probeHttp, scanPorts } from "./ports.js";
import { PreviewProfileStore, profilePartition } from "./profiles.js";
import { PREVIEW_WINDOW_UNAVAILABLE, previewWindowUnavailable } from "./window-availability.js";
import { pageCall, type PreviewActionResult } from "./page-script.js";
import { POINTER_PATH, previewAgentCursor, previewInputOverlay, previewInputOverlayEnd, previewSecretNote, type PageCursorMark } from "./page-cursor.js";
import { CURSOR_ACTIVE_MS, LABEL_VISIBLE_MS, cursorMark } from "./agent-cursor-marks.js";
import type { ScreenAction } from "./screen-protocol.js";
import { PreviewHistory } from "./history.js";
import { PreviewMiniState } from "./mini-state.js";
import { previewTools, type PreviewToolController } from "./agent-tools.js";
import { defaultsFromSettings } from "./settings.js";
import { DEFAULT_PREVIEW_DEFAULTS, fitViewport, readAppearance, readDefaults, readViewport, readZoom, stepZoom } from "./viewport.js";
import { CookieImportHost, type CookieImportWindow } from "./cookie-import-host.js";
import { pageInput, previewFocusKind, readPreviewInput, type PreviewPageInput } from "./remote-input.js";
import { pinnedWindowCalls } from "../_host-window/pinned-calls.js";
import { DeviceLayout, readPreviewViewer, type PreviewDeviceMetrics } from "./device-layout.js";

/** Where the view is drawn inside the window, in device-independent pixels. */
export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The browser the tools drive. Electron's `WebContentsView` is one
 * implementation; a host in its own process drives the same view through the
 * kit's window half (`remote-surface.ts`).
 */
export interface PreviewSurface {
  /** A remote surface takes the state its window half reports between calls. */
  accept?(snapshot: unknown): void;
  /** Zoom of the window the panel is drawn in; the panel measures in CSS pixels. */
  zoomFactor(): number;
  /** With `device`, the page is laid out for that device's screen whatever the rectangle; without, for the rectangle. */
  place(rect: PreviewRect, visible: boolean, device?: PreviewDeviceMetrics): void;
  load(url: string, timeoutMs: number): Promise<void>;
  navigate(action: "back" | "forward" | "reload" | "hard-reload"): void;
  /** The page's own zoom, kept across its navigations. */
  setZoom(factor: number): void;
  setAppearance(appearance: PreviewAppearance): Promise<void>;
  state(): PreviewState;
  /** The page's viewport in its CSS pixels. */
  viewport(): { width: number; height: number };
  /** `isolated` runs it in a world of its own, where the page's scripts cannot reach its state. */
  evaluate(expression: string, isolated?: boolean): Promise<unknown>;
  /** `rect`, in the page's CSS pixels, cuts the capture to that part of the view; `jpeg` for a small picture. */
  capture(maxWidth: number, rect?: PreviewRect, jpeg?: boolean): Promise<{ base64: string; width: number; height: number }>;
  /** A webm recording of the view: `take` answers the chunks since the last call, base64. */
  record(action: "start" | "take" | "stop", options?: { frameRate?: number }): Promise<PreviewRecordingChunks>;
  pressKey(key: string): void | Promise<void>;
  /** Trusted input from a device that shows the page; a surface without it cannot be driven remotely. */
  input?(event: PreviewPageInput): Promise<void>;
  /** Saves to a new file in the window's workspace, without a native dialog or overwrite. */
  download?(url: string, destination: string): Promise<{ path: string }>;
  destroy(): void;
}

export interface PreviewRecordingChunks {
  chunks: string[];
  mimeType: string;
}

export interface PreviewSurfaceOptions {
  /** The session partition of the profile in use. */
  partition: string;
  onChange(): void;
  /** The page's own keys asked to reload or zoom it. */
  onChord?(chord: PreviewChord): void;
  /** Workspace of the thread being previewed; the only place `file://` may point into. */
  workspaceRoot(): string;
  log(label: string, detail?: string): void;
  /** Reaches this kit's window half, when the host has a client that holds one. */
  callClient?(command: string, input?: unknown): Promise<unknown>;
}

export type PreviewSurfaceFactory = (options: PreviewSurfaceOptions) => Promise<PreviewSurface | undefined>;

/** Forgets a deleted profile's cookies and storage, wherever the window lives. */
export type PreviewPartitionCleaner = (partition: string, callClient: (command: string, input?: unknown) => Promise<unknown>) => Promise<void>;

const LOAD_TIMEOUT_MS = 15_000;
const SCREENSHOT_MAX_WIDTH = 1_280;
const MINI_FRAME_WIDTH = 640;
const LIVE_FRAME_WIDTH = { min: 120, max: 1_600 } as const;
/** Clients asking within this long share one capture. */
const LIVE_FRAME_SHARED_MS = 150;
/** A view nobody placed yet still lays the page out at this size, so a remote device sees something. */
const UNPLACED_RECT: PreviewRect = { x: 0, y: 0, width: 1_280, height: 800 };
const NO_DESKTOP = PREVIEW_WINDOW_UNAVAILABLE;

export interface WindowFacts {
  /** The host runs inside the window's own process. */
  inWindowProcess: boolean;
  /** A window on this machine holds the half now; undefined when core cannot say (before API 1.13.0). */
  windowAttached: boolean | undefined;
  platform: NodeJS.Platform;
  /** `DISPLAY` is set: a Linux service host with a display starts its window when a call needs one. */
  display: boolean;
  /** The last call to the window found none. */
  callFoundNone: boolean;
}

/** Why no window on this machine can draw the page, or nothing when one can or will. */
export function missingWindow(facts: WindowFacts): PreviewNoWindow | undefined {
  if (facts.inWindowProcess || facts.windowAttached !== false) return undefined;
  if (facts.platform === "linux") {
    if (!facts.display) return { displayService: true };
    return facts.callFoundNone ? { displayService: false } : undefined;
  }
  return { displayService: false };
}
const PICK_POLL_MS = 200;
const PICK_TIMEOUT_MS = 5 * 60_000;
const PICK_IMAGE_MAX_WIDTH = 1_200;
const RECORDING_DRAIN_MS = 1_000;
const RECORDING_MAX_MS = 10 * 60_000;
const RECORDING_MAX_BYTES = 500 * 1024 * 1024;
const PORTS_FRESH_MS = 2_000;
const AGENT_ACTIONS_KEPT = 12;

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** A read-only probe of the machine; a tool that fails or is missing answers nothing. */
function runReadOnly(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_error, stdout) => {
      // `lsof` exits 1 when one of several pids has nothing to show; its output still counts.
      resolve(typeof stdout === "string" ? stdout : "");
    });
  });
}

const image = (shot: { base64: string; width: number; height: number }): PreviewImage =>
  ({ data: shot.base64, width: shot.width, height: shot.height });

interface ActiveRecording {
  surface: PreviewSurface;
  path: string;
  name: string;
  file: FileHandle;
  since: number;
  bytes: number;
  mimeType: string;
  timer: ReturnType<typeof setInterval>;
  /** Writes happen in order; each drain waits for the one before. */
  queue: Promise<void>;
  /** The page the input overlay was put on; a navigation needs it again. */
  overlayUrl: string;
}

/**
 * The panel measures itself in CSS pixels; the window places views in
 * device-independent ones, which differ whenever the workbench is zoomed.
 */
export function previewRect(bounds: PreviewBounds, zoomFactor: number): PreviewRect {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.max(0, Math.round(bounds.width * zoom)),
    height: Math.max(0, Math.round(bounds.height * zoom)),
  };
}

/** A panel that is hidden, collapsed or scrolled out of the dock has nothing to draw over. */
export function previewVisible(bounds: PreviewBounds): boolean {
  return bounds.visible && bounds.width > 8 && bounds.height > 8;
}

export function readPreviewBounds(input: unknown): PreviewBounds {
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const number = (key: string): number => {
    const value = fields[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return { x: number("x"), y: number("y"), width: number("width"), height: number("height"), visible: fields.visible === true };
}

/**
 * What the preview may load: web pages, and files of the thread's own
 * workspace. A `javascript:` or `data:` URL never becomes a page.
 */
export function normalizePreviewUrl(input: unknown, workspaceRoot: string, platform: NodeJS.Platform = process.platform): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new Error("Preview needs a URL.");
  const windows = platform === "win32";
  // `C:\site\index.html` would otherwise read as the scheme `c:`.
  const windowsPath = windows && (/^[a-z]:[\\/]/iu.test(raw) || raw.startsWith("\\\\"));
  // `localhost:3000` is a host and a port, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(raw) && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/iu.test(raw);
  const candidate = windowsPath ? pathToFileURL(raw, { windows: true }).href
    : raw.startsWith("/") ? `file://${raw}` : hasScheme ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Not a URL Preview can open: ${raw}`);
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  if (url.protocol === "about:" && url.pathname === "blank") return "about:blank";
  if (url.protocol !== "file:") throw new Error(`Preview opens http, https and workspace files only, not ${url.protocol}`);
  let path = "";
  try {
    path = windows ? fileURLToPath(url, { windows: true }) : decodeURIComponent(url.pathname);
  } catch {
    // A file URL without a drive letter names nothing on Windows.
  }
  const sep = windows ? win32.sep : posix.sep;
  const root = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  // Windows paths compare case-insensitively.
  const inside = windows ? path.toLowerCase().startsWith(root.toLowerCase()) : path.startsWith(root);
  if (!workspaceRoot || !path || !inside) throw new Error("Preview opens local files only inside the workspace.");
  return url.toString();
}

/** The agent's input as the cursor marks read it: E24's shape, in the page's CSS pixels. */
export function agentAction(
  id: string,
  kind: "click" | "type" | "key" | "scroll",
  result: PreviewActionResult | undefined,
  detail: { text?: string; key?: string; direction?: "up" | "down" | "left" | "right" } = {},
): ScreenAction {
  const typed = kind === "type" && detail.text !== undefined
    ? { text: result?.sensitive ? "•".repeat(Math.min(12, Math.max(4, detail.text.length))) : detail.text.slice(0, 60) }
    : {};
  return {
    id,
    kind,
    at: Date.now(),
    ...(result?.point ? { point: result.point } : {}),
    ...(result?.viewport ? { space: result.viewport } : {}),
    ...typed,
    ...(kind === "key" && detail.key ? { keys: [detail.key] } : {}),
    ...(kind === "scroll" && detail.direction ? { direction: detail.direction } : {}),
    status: result?.ok === false ? "failed" : "done",
  };
}

/**
 * One preview per host: the view, the panel bounds it is placed by, and the
 * tools' access to it. Everything Electron is behind `PreviewSurface`.
 */
class PreviewController implements PreviewToolController {
  private view: PreviewSurface | undefined;

  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };

  private lastPublished = "";

  private workspaceRoot = "";

  /** False once this host proved it has no window to draw in. */
  private available = true;

  /** The last window call found no window on this machine; cleared once one is there. */
  private windowCallFoundNone = false;
  private windowCannotDraw = false;

  private readonly profiles: PreviewProfileStore;

  private readonly history: PreviewHistory;

  private readonly mini: PreviewMiniState;

  private mode: PreviewState["mode"];

  /** Bumped whenever a pick is superseded, so its poll loop knows to stop. */
  private pickToken = 0;

  private recording: ActiveRecording | undefined;

  private recordingNotice: string | undefined;

  private shownUrl = "";
  /** The user holds the page; the page the note was put on, empty to put it on again. */
  private held = false;
  private heldUrl = "";

  private rememberedTitle = "";

  private portScan: { at: number; cwd: string; servers: Promise<PreviewServer[]> } | undefined;

  private defaults: PreviewDefaults = DEFAULT_PREVIEW_DEFAULTS;

  /** What the page shows now; a new view starts from the defaults. */
  private zoom = DEFAULT_PREVIEW_DEFAULTS.zoom;

  private viewport: PreviewViewport = DEFAULT_PREVIEW_DEFAULTS.viewport;

  private appearance: PreviewAppearance = DEFAULT_PREVIEW_DEFAULTS.appearance;

  private agentActions: ScreenAction[] = [];

  private actionCount = 0;

  /** The one window on the host's machine the view lives in; every call goes there, whoever asks. */
  private readonly window: ReturnType<typeof pinnedWindowCalls>;

  private liveCapture: { maxWidth: number; at: number; frame: Promise<{ id: string; data: string; width: number; height: number; url: string } | null> } | undefined;

  private readonly layout = new DeviceLayout(() => {
    this.liveCapture = undefined;
    this.place();
    this.publish();
  });

  constructor(
    private readonly createSurface: PreviewSurfaceFactory,
    private readonly clearPartition: PreviewPartitionCleaner,
    private readonly context: HostExtensionContext,
  ) {
    this.profiles = new PreviewProfileStore(context.services.stateDir);
    this.history = new PreviewHistory(context.services.stateDir);
    this.mini = new PreviewMiniState(context.services.stateDir);
    // A window that replaced the view's (the invisible display's, restarted) has no view yet.
    this.window = pinnedWindowCalls(context.services, { onMoved: () => this.reopen() });
    void this.mini.load().then(() => this.publish());
  }

  /** Makes the view again in a new window, where the page, size and place of the old one are unknown. */
  private async reopen(): Promise<void> {
    const view = this.view as (PreviewSurface & { open?(): Promise<void> }) | undefined;
    if (!view?.open) return;
    const url = view.state().url;
    await view.open();
    this.place();
    if (url) await view.load(url, LOAD_TIMEOUT_MS);
  }

  /** The kit's window half, in the window that holds the view. */
  async windowCall(command: string, input?: unknown): Promise<unknown> {
    try {
      const answer = await this.window.call(command, input);
      this.windowCallFoundNone = false;
      this.windowCannotDraw = false;
      return answer;
    } catch (error) {
      if (previewWindowUnavailable(error)) {
        this.windowCannotDraw = error instanceof Error && !error.message.startsWith("No Tau window");
        if (!this.windowCallFoundNone) {
          this.windowCallFoundNone = true;
          this.publish();
        }
        throw new Error(PREVIEW_WINDOW_UNAVAILABLE, { cause: error });
      }
      throw error;
    }
  }

  private noWindow(): PreviewNoWindow | undefined {
    let attached: boolean | undefined;
    try {
      attached = this.context.services.clientWindow ? this.context.services.clientWindow() !== undefined : undefined;
    } catch {
      attached = undefined;
    }
    // A Mac's auxiliary connection can still advertise its half after the window closes.
    // Only a successful call proves that this connected process can draw again.
    if (this.windowCannotDraw) attached = false;
    if (attached) this.windowCallFoundNone = false;
    return missingWindow({
      inWindowProcess: process.type === "browser",
      windowAttached: attached,
      platform: process.platform,
      display: Boolean(process.env.DISPLAY),
      callFoundNone: this.windowCallFoundNone,
    });
  }

  /** The workspace of the thread whose runtime asked, which gates `file://`. */
  noteWorkspace(cwd: string): void {
    if (cwd) this.workspaceRoot = cwd;
  }

  /** The view, created on first use; a host without a window has none. */
  async surface(): Promise<PreviewSurface> {
    if (this.view) return this.view;
    const { active } = await this.profiles.read();
    if (this.view) return this.view;
    const created = await this.createSurface({
      partition: profilePartition(active),
      onChange: () => this.publish(),
      onChord: (chord) => { void this.chord(chord).catch(() => undefined); },
      workspaceRoot: () => this.workspaceRoot,
      log: (label, detail) => this.context.services.log(label, detail),
      callClient: (command, input) => this.windowCall(command, input),
    });
    if (!created) {
      this.available = false;
      throw new Error(NO_DESKTOP);
    }
    this.view = created;
    this.place();
    if (this.appearance !== "system") await created.setAppearance(this.appearance).catch(() => undefined);
    return created;
  }

  page(): Promise<PreviewSurface> {
    return this.surface();
  }

  state(): PreviewState {
    const page = this.view?.state() ?? { ...EMPTY_PREVIEW_STATE, available: this.available };
    const driver: PreviewDriver | undefined = this.mini.driver();
    const layoutFor = this.viewport.mode === "fill" ? this.layout.owner() : undefined;
    const noWindow = this.noWindow();
    return {
      ...page,
      profile: this.profiles.snapshot().active,
      zoom: this.zoom,
      viewport: this.viewport,
      appearance: this.appearance,
      mini: this.mini.miniPrefs(),
      ...(driver ? { driver } : {}),
      ...(layoutFor ? { layoutFor } : {}),
      ...(noWindow ? { noWindow } : {}),
      ...(this.mode ? { mode: this.mode } : {}),
      ...(this.recording ? { recordingSince: this.recording.since } : {}),
      ...(this.recordingNotice ? { recordingNotice: this.recordingNotice } : {}),
    };
  }

  /**
   * The panel's rectangle, the viewport inside it, and the page zoom that keeps
   * a fixed viewport's CSS size. A device's layout replaces a filling viewport
   * only; a fixed one is a size somebody chose.
   */
  private place(): void {
    const view = this.view;
    if (!view) return;
    const measured = this.bounds.width > 0 && this.bounds.height > 0;
    const rect = measured ? previewRect(this.bounds, view.zoomFactor()) : UNPLACED_RECT;
    const device = this.viewport.mode === "fill" ? this.layout.metrics() : undefined;
    if (device) {
      view.place(rect, previewVisible(this.bounds), device);
      view.setZoom(1);
      return;
    }
    const fitted = fitViewport(rect, this.viewport, this.zoom);
    view.place(fitted.rect, previewVisible(this.bounds));
    view.setZoom(fitted.zoom);
  }

  setBounds(bounds: PreviewBounds): void {
    const shown = previewVisible(this.bounds);
    this.bounds = bounds;
    // The window shows the page again: it gets its own layout back, before it is drawn.
    if (!shown && previewVisible(bounds)) this.layout.release();
    this.place();
  }

  /** A device's own layout changes what the agent and the host window see: Full access only. */
  private mayLayOut(call: HostCommandCall | undefined): boolean {
    if (!call || call.extension) return false;
    if (call.device === undefined) return true;
    return this.context.services.clients?.devices?.().find((device) => device.id === call.device)?.access === "full";
  }

  private viewerName(call: HostCommandCall | undefined): string {
    const device = call?.device === undefined ? undefined : this.context.services.clients?.devices?.().find((entry) => entry.id === call.device);
    return device?.name || "Another device";
  }

  /** `layout`: lay the page out for the calling device, or give it back to the host window. */
  setLayout(input: unknown, call: HostCommandCall | undefined): PreviewState {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (typeof fields.release === "string") {
      this.layout.release(fields.release);
      return this.state();
    }
    if (fields.viewer === undefined) {
      this.layout.release();
      return this.state();
    }
    const viewer = readPreviewViewer(fields.viewer);
    if (!viewer) throw new HostCommandError("Not a device: an id, and a width and height in CSS pixels.");
    if (!this.mayLayOut(call)) throw new HostCommandError("This device may watch the page, not lay it out for itself.");
    if (this.viewport.mode !== "fill") throw new HostCommandError("The page has a fixed viewport; choose Fill in the Preview's viewport menu first.");
    this.layout.claim(viewer, this.viewerName(call));
    return this.state();
  }

  async close(): Promise<PreviewState> {
    this.pickToken += 1;
    this.mode = undefined;
    await this.recordStop().catch(() => null);
    this.view?.destroy();
    this.view = undefined;
    this.window.release();
    this.layout.dispose();
    this.liveCapture = undefined;
    this.agentActions = [];
    this.publish();
    return this.state();
  }

  /** The window half reported a change; its snapshot is this surface's state. */
  acceptRemoteState(snapshot: unknown): PreviewState {
    this.view?.accept?.(snapshot);
    this.publish();
    return this.state();
  }

  publish(): void {
    const state = this.state();
    // A navigation took the annotation layer, the agent's cursor and the input overlay with the page.
    if (state.url !== this.shownUrl) {
      this.shownUrl = state.url;
      this.rememberedTitle = "";
      this.agentActions = [];
      if (this.mode === "annotate") {
        this.mode = undefined;
        return this.publish();
      }
    }
    if (state.url && !state.loading && state.title !== this.rememberedTitle) {
      this.rememberedTitle = state.title;
      this.history.visit(state.url, state.title);
    }
    if (this.held && state.loading) this.heldUrl = "";
    if (this.held && state.url && !state.loading && this.heldUrl !== state.url) {
      this.heldUrl = state.url;
      void this.view?.evaluate(pageCall(previewSecretNote, true), true).catch(() => undefined);
    }
    const recording = this.recording;
    if (recording && state.url && !state.loading && recording.overlayUrl !== state.url) {
      recording.overlayUrl = state.url;
      void this.showInputOverlay(recording.surface);
    }
    const encoded = JSON.stringify(state);
    if (encoded === this.lastPublished) return;
    this.lastPublished = encoded;
    this.context.emit(PREVIEW_STATE_EVENT, state);
  }

  async open(url: unknown): Promise<PreviewState> {
    const resolved = normalizePreviewUrl(url, this.workspaceRoot);
    const surface = await this.surface();
    await surface.load(resolved, LOAD_TIMEOUT_MS);
    this.publish();
    return surface.state();
  }

  async navigate(input: unknown): Promise<PreviewState> {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (typeof fields.url === "string" && fields.url) return this.open(fields.url);
    const step = fields.action;
    if (step !== "back" && step !== "forward" && step !== "reload" && step !== "hard-reload") throw new Error("preview_navigate needs a url or action back, forward or reload.");
    const surface = await this.surface();
    surface.navigate(step);
    this.publish();
    return surface.state();
  }

  /** The page's own ⌘R and zoom chords, sent by the view that has the keyboard. */
  async chord(chord: PreviewChord): Promise<PreviewState> {
    if (chord === "reload" || chord === "hard-reload") return this.navigate({ action: chord });
    return this.setZoom({ step: chord === "zoom-in" ? "in" : chord === "zoom-out" ? "out" : "reset" });
  }

  setZoom(input: unknown): PreviewState {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const step = fields.step === "in" || fields.step === "out" || fields.step === "reset" ? fields.step : undefined;
    const next = step ? stepZoom(this.zoom, step) : readZoom(fields.factor);
    if (next === undefined) throw new Error("Zoom needs a step (in, out, reset) or a factor.");
    this.zoom = next;
    this.place();
    this.publish();
    return this.state();
  }

  async resize(viewport: PreviewViewport): Promise<PreviewState> {
    this.viewport = viewport;
    await this.surface();
    this.place();
    this.publish();
    return this.state();
  }

  async setAppearance(appearance: PreviewAppearance): Promise<PreviewState> {
    const surface = await this.surface();
    await surface.setAppearance(appearance);
    this.appearance = appearance;
    this.publish();
    return this.state();
  }

  /**
   * New defaults from Settings. What the user or the agent set for the page
   * stays; a value still at the old default follows the new one.
   */
  currentDefaults(): PreviewDefaults {
    return this.defaults;
  }

  async setDefaults(input: unknown): Promise<void> {
    const previous = this.defaults;
    const next = readDefaults(input);
    this.defaults = next;
    if (this.zoom === previous.zoom) this.zoom = next.zoom;
    if (JSON.stringify(this.viewport) === JSON.stringify(previous.viewport)) this.viewport = next.viewport;
    const appearance = this.appearance === previous.appearance ? next.appearance : this.appearance;
    this.place();
    if (appearance !== this.appearance && this.view) await this.setAppearance(appearance).catch(() => undefined);
    else this.appearance = appearance;
    this.publish();
  }

  /** Runs a snippet in the page; the tools never touch the surface directly. */
  async evaluate(expression: string): Promise<unknown> {
    return (await this.surface()).evaluate(expression);
  }

  drive(threadId: string, source: PreviewDriver["source"] = "browser"): void {
    if (this.mini.drive(threadId, source)) this.publish();
  }

  releaseDriver(threadId: string): void {
    if (this.mini.release(threadId)) this.publish();
  }

  dismissMini(): PreviewState {
    if (this.mini.dismiss()) this.publish();
    return this.state();
  }

  async setMiniPrefs(input: unknown): Promise<PreviewState> {
    await this.mini.setPrefs(input);
    this.publish();
    return this.state();
  }

  /** A small JPEG of the page for the floating preview; nothing while no page is open. */
  async miniFrame(): Promise<PreviewFrame | null> {
    const view = this.view;
    if (!view || !view.state().url) return null;
    const shot = await view.capture(MINI_FRAME_WIDTH, undefined, true);
    return { data: shot.base64, width: shot.width, height: shot.height };
  }

  /**
   * A picture of the page for one client that shows it, at the width it asked
   * for. Clients asking at once share a capture; one that still shows the same
   * picture gets its id back without the bytes.
   */
  async liveFrame(input: unknown, call?: HostCommandCall): Promise<PreviewLiveFrame | null> {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const asked = typeof fields.maxWidth === "number" && Number.isFinite(fields.maxWidth) ? fields.maxWidth : MINI_FRAME_WIDTH;
    const maxWidth = Math.round(Math.min(LIVE_FRAME_WIDTH.max, Math.max(LIVE_FRAME_WIDTH.min, asked)));
    const view = this.view;
    if (!view || !view.state().url) return null;
    const viewer = readPreviewViewer(fields.viewer);
    if (viewer && this.viewport.mode === "fill" && this.mayLayOut(call)) this.layout.watch(viewer, this.viewerName(call), previewVisible(this.bounds));
    const recent = this.liveCapture;
    const now = Date.now();
    const shared = recent && recent.maxWidth === maxWidth && now - recent.at < LIVE_FRAME_SHARED_MS ? recent.frame : undefined;
    const frame = shared ?? view.capture(maxWidth, undefined, true).then((shot) => shot.width > 0 && shot.height > 0
      ? { id: createHash("sha1").update(shot.base64).digest("base64url").slice(0, 16), data: shot.base64, width: shot.width, height: shot.height, url: view.state().url }
      : null);
    if (!shared) this.liveCapture = { maxWidth, at: now, frame };
    const taken = await frame.catch(() => null);
    if (!taken) return null;
    return taken.id === fields.since ? { id: taken.id, unchanged: true } : taken;
  }

  /**
   * A device's tap, text or key, as trusted input to the page. The answer says
   * whether a secret has the keyboard now, so the device masks its own field.
   */
  async input(raw: unknown): Promise<PreviewInputResult> {
    const input = readPreviewInput(raw);
    const surface = await this.loadedPage("sending it input");
    if (!surface.input) throw new Error("This preview cannot take input from another device.");
    await surface.input(pageInput(input, surface.viewport()));
    this.liveCapture = undefined;
    const focus = await surface.evaluate(pageCall(previewFocusKind), true).catch(() => "none");
    this.publish();
    return { focus: focus === "secret" || focus === "field" ? focus : "none" };
  }

  async download(url: string, destination: string): Promise<{ path: string }> {
    const surface = await this.surface();
    if (!surface.download) throw new Error("This preview cannot download to an explicit destination.");
    return surface.download(url, destination);
  }

  /** The agent's cursor goes where its action landed, in the page, so a recording shows it too. */
  pointAt(kind: "click" | "type" | "key" | "scroll", result: PreviewActionResult | undefined, detail?: { text?: string; key?: string; direction?: "up" | "down" | "left" | "right" }): void {
    const view = this.view;
    if (!view) return;
    this.actionCount += 1;
    this.agentActions = [...this.agentActions, agentAction(`a${this.actionCount}`, kind, result, detail)].slice(-AGENT_ACTIONS_KEPT);
    const mark = cursorMark(this.agentActions);
    if (!mark || (!mark.at && !mark.label)) return;
    const page: PageCursorMark = {
      id: mark.id,
      kind: mark.kind,
      failed: mark.failed,
      ...(mark.at ? { x: mark.at.x, y: mark.at.y } : {}),
      ...(mark.to ? { toX: mark.to.x, toY: mark.to.y } : {}),
      ...(mark.label ? { label: mark.label } : {}),
    };
    void view.evaluate(pageCall(previewAgentCursor, page, { activeMs: CURSOR_ACTIVE_MS, labelMs: LABEL_VISIBLE_MS }, POINTER_PATH), true).catch(() => undefined);
  }

  private async loadedPage(verb: string): Promise<PreviewSurface> {
    const surface = await this.surface();
    if (!surface.state().url) throw new Error(`Open a page before ${verb}.`);
    return surface;
  }

  /**
   * Arms pick mode and waits for the user: the element they clicked with an
   * image of it, or `null` when they gave up, navigated or picked again.
   */
  async pick(): Promise<{ element: PreviewPickedElement; image?: PreviewImage } | null> {
    const surface = await this.loadedPage("picking an element");
    await this.annotateCancel();
    const token = ++this.pickToken;
    this.mode = "pick";
    this.publish();
    try {
      await surface.evaluate(pageCall(previewPickArm, previewDescribe, previewSelector), true);
      const deadline = Date.now() + PICK_TIMEOUT_MS;
      for (;;) {
        if (token !== this.pickToken || this.view !== surface) return null;
        const poll = await surface.evaluate(pageCall(previewPickPoll), true) as PreviewPickPoll | undefined;
        if (poll?.state === "done") {
          const element = readPickedElement(poll.element);
          if (!element) throw new Error("The page answered the pick with something that is not an element.");
          const crop = pickCrop(element.rect, element.viewport);
          const shot = crop ? await surface.capture(PICK_IMAGE_MAX_WIDTH, crop).catch(() => undefined) : undefined;
          return { element, ...(shot ? { image: image(shot) } : {}) };
        }
        if (poll?.state !== "armed") return null;
        if (Date.now() >= deadline) {
          await surface.evaluate(pageCall(previewPickCancel), true).catch(() => undefined);
          return null;
        }
        await delay(PICK_POLL_MS);
      }
    } finally {
      if (token === this.pickToken) {
        this.mode = undefined;
        this.publish();
      }
    }
  }

  async cancelPick(): Promise<void> {
    this.pickToken += 1;
    if (this.mode === "pick") {
      this.mode = undefined;
      this.publish();
    }
    await this.view?.evaluate(pageCall(previewPickCancel), true).catch(() => undefined);
  }

  /** Starts annotate mode, or switches its tool. */
  async annotate(tool: unknown): Promise<void> {
    if (tool !== "rect" && tool !== "arrow" && tool !== "note") throw new Error("Annotate with rect, arrow or note.");
    const surface = await this.loadedPage("annotating it");
    if (this.mode === "pick") await this.cancelPick();
    await surface.evaluate(pageCall(previewAnnotateStart, tool satisfies PreviewAnnotationTool), true);
    this.mode = "annotate";
    this.publish();
  }

  async annotateCancel(): Promise<void> {
    if (this.mode !== "annotate") return;
    this.mode = undefined;
    this.publish();
    await this.view?.evaluate(pageCall(previewAnnotateEnd), true).catch(() => undefined);
  }

  /** The marks and their notes, and the page with them drawn on it; the layer goes afterwards. */
  async annotateSend(): Promise<{ annotations: PreviewAnnotationResult; image?: PreviewImage } | null> {
    const surface = await this.loadedPage("annotating it");
    try {
      const annotations = readAnnotationResult(await surface.evaluate(pageCall(previewAnnotateCollect), true));
      if (!annotations) return null;
      const shot = await surface.capture(SCREENSHOT_MAX_WIDTH).catch(() => undefined);
      return { annotations, ...(shot ? { image: image(shot) } : {}) };
    } finally {
      await surface.evaluate(pageCall(previewAnnotateEnd), true).catch(() => undefined);
      this.mode = undefined;
      this.publish();
    }
  }

  async hold(input: unknown): Promise<void> {
    this.held = (input as { on?: unknown } | undefined)?.on === true;
    this.heldUrl = "";
    if (this.held) this.publish();
    else await this.view?.evaluate(pageCall(previewSecretNote, false), true).catch(() => undefined);
  }

  private async showInputOverlay(surface: PreviewSurface): Promise<void> {
    const { showKeys, showClicks } = this.defaults.recording;
    await surface.evaluate(pageCall(previewInputOverlay, { keys: showKeys, clicks: showClicks }, POINTER_PATH), true).catch(() => undefined);
  }

  async recordStart(): Promise<PreviewState> {
    if (this.recording) return this.state();
    const surface = await this.loadedPage("recording it");
    const directory = join(this.context.services.stateDir, "recordings");
    await mkdir(directory, { recursive: true });
    const name = `preview-${new Date().toISOString().replace(/[:.]/gu, "-")}.webm`;
    const path = join(directory, name);
    const file = await open(path, "w");
    let started: PreviewRecordingChunks;
    // The drawn pointer is there before the first frame, so the video never shows two.
    await this.showInputOverlay(surface);
    try {
      started = await surface.record("start", { frameRate: this.defaults.recording.frameRate });
    } catch (error) {
      await surface.evaluate(pageCall(previewInputOverlayEnd), true).catch(() => undefined);
      await file.close();
      throw error;
    }
    const timer = setInterval(() => this.drain(), RECORDING_DRAIN_MS);
    timer.unref?.();
    this.recordingNotice = undefined;
    const overlayUrl = surface.state().url;
    this.recording = { surface, path, name, file, since: Date.now(), bytes: 0, mimeType: started.mimeType || "video/webm", timer, queue: Promise.resolve(), overlayUrl };
    await this.write(this.recording, started.chunks);
    this.publish();
    return this.state();
  }

  private async write(recording: ActiveRecording, chunks: readonly string[]): Promise<void> {
    for (const chunk of chunks) {
      const bytes = Buffer.from(chunk, "base64");
      await recording.file.write(bytes);
      recording.bytes += bytes.length;
    }
  }

  /** Moves what the recorder holds into the file; stops at the caps. */
  private drain(): void {
    const recording = this.recording;
    if (!recording) return;
    recording.queue = recording.queue.then(async () => {
      if (this.recording !== recording) return;
      try {
        await this.write(recording, (await recording.surface.record("take")).chunks);
      } catch (error) {
        this.recordingNotice = `Recording stopped: ${error instanceof Error ? error.message : String(error)}`;
        await this.recordStop().catch(() => null);
        return;
      }
      const tooLong = Date.now() - recording.since >= RECORDING_MAX_MS;
      if (tooLong || recording.bytes >= RECORDING_MAX_BYTES) {
        const stopped = await this.recordStop().catch(() => null);
        if (stopped) this.recordingNotice = `Recording stopped at ${tooLong ? "10 minutes" : "500 MB"}; saved to ${stopped.path}`;
        this.publish();
      }
    });
  }

  async recordStop(): Promise<PreviewRecording | null> {
    const recording = this.recording;
    if (!recording) return null;
    this.recording = undefined;
    clearInterval(recording.timer);
    try {
      await recording.queue;
      await this.write(recording, (await recording.surface.record("stop").catch(() => ({ chunks: [] as string[] }))).chunks);
    } finally {
      await recording.file.close();
      await recording.surface.evaluate(pageCall(previewInputOverlayEnd), true).catch(() => undefined);
      this.publish();
    }
    return { path: recording.path, name: recording.name, size: recording.bytes, durationMs: Date.now() - recording.since, mimeType: recording.mimeType.split(";")[0] || "video/webm" };
  }

  /** One frame for evidence: nothing without a page, nothing while a secret has the keyboard. */
  async evidenceFrame(maxWidth: number): Promise<PreviewEvidenceFrame> {
    const view = this.view;
    const state = view?.state();
    if (!view || !state?.url || state.url === "about:blank") return { skipped: "closed" };
    // A page that cannot answer mid-navigation counts as one that might hold a secret.
    if (await view.evaluate(pageCall(previewSecretFocus), true).catch(() => true) !== false) return { skipped: "secret" };
    // A window on a hidden Space or mid-teardown cannot be drawn; that is a skipped frame, not a failed command.
    const shot = await view.capture(maxWidth).catch(() => undefined);
    if (!shot) return { skipped: "unavailable" };
    if (shot.width < 1 || shot.height < 1) return { skipped: "empty" };
    return { data: shot.base64, width: shot.width, height: shot.height, url: state.url, title: state.title, visible: previewVisible(this.bounds) };
  }

  async profileList(): Promise<PreviewProfiles> {
    return this.profiles.read();
  }

  /** Another profile means another session, so the view is built again and the page reloaded in it. */
  async useProfile(name: unknown): Promise<PreviewProfiles> {
    const before = (await this.profiles.read()).active;
    const profiles = await this.profiles.use(name);
    if (profiles.active !== before) await this.reopenInActiveProfile();
    return profiles;
  }

  private async reopenInActiveProfile(): Promise<void> {
    const url = this.view?.state().url ?? "";
    if (this.view) await this.close();
    if (url && url !== "about:blank") await this.open(url).catch(() => undefined);
    this.publish();
  }

  async renameProfile(input: unknown): Promise<PreviewProfiles> {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return this.profiles.rename(fields.id, fields.name);
  }

  /** Forgets a profile and its cookies; a page open in it moves to the default profile. */
  async deleteProfile(input: unknown): Promise<PreviewProfiles> {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const before = (await this.profiles.read()).active;
    const profiles = await this.profiles.remove(fields.id);
    const id = String(fields.id);
    // The partition goes with its view: a session in use cannot be cleared under it.
    if (before === id) await this.reopenInActiveProfile();
    await this.clearPartition(profilePartition(id), (command, value) => this.window.call(command, value))
      .catch((error: unknown) => this.context.services.log("preview.profile.clear-failed", error instanceof Error ? error.message : String(error)));
    return profiles;
  }

  historyList(): Promise<PreviewHistoryEntry[]> {
    return this.history.list();
  }

  forget(input: unknown): Promise<PreviewHistoryEntry[]> {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return this.history.forget(fields.url);
  }

  /** After a cookie import: the page in view sees the new cookies once it loads again. */
  async reloadIn(profile: string): Promise<boolean> {
    if ((await this.profiles.read()).active !== profile || !this.view?.state().url) return false;
    this.view.navigate("reload");
    this.publish();
    return true;
  }

  /** Local servers for the address bar; a scan a moment old is answered again. */
  ports(cwd: unknown): Promise<PreviewServer[]> {
    const root = typeof cwd === "string" && cwd ? cwd : this.workspaceRoot;
    const cached = this.portScan;
    if (cached && cached.cwd === root && Date.now() - cached.at < PORTS_FRESH_MS) return cached.servers;
    const { services } = this.context;
    const servers = scanPorts({
      workspaceRoot: root,
      platform: process.platform,
      ownPids: new Set([process.pid, process.ppid]),
      findCommand: (name) => services.findCommand(name),
      run: (command, args) => {
        services.noteSubprocess();
        return runReadOnly(command, args);
      },
      probe: (url) => probeHttp(url),
    }).catch(() => []);
    this.portScan = { at: Date.now(), cwd: root, servers };
    return servers;
  }

  dispose(): void {
    this.pickToken += 1;
    void this.history.flush();
    void this.close();
  }
}

/**
 * Where the view is built. `process.type === "browser"` is the Electron main
 * process, which can create one itself; a host in its own process asks the
 * window half instead, and a host with neither has no preview at all.
 */
const electronSurface: PreviewSurfaceFactory = async (options) => {
  if (process.type === "browser") {
    const { createElectronPreviewSurface } = await import("./view.js");
    return createElectronPreviewSurface(options);
  }
  if (!options.callClient) return undefined;
  const { createRemotePreviewSurface } = await import("./remote-surface.js");
  const call = options.callClient;
  const surface = createRemotePreviewSurface(options, (command, input) => call(command, input));
  // The view exists once the window half made it; a refused call means no window.
  await surface.open();
  return surface;
};

const electronPartitionCleaner: PreviewPartitionCleaner = async (partition, callClient) => {
  if (process.type === "browser") {
    const { clearPreviewPartition } = await import("./view.js");
    return clearPreviewPartition(partition);
  }
  await callClient("clear-partition", { target: partition });
};

/** Computer Use's tools, whichever runtime reports them. */
const DRIVES_A_WINDOW = /(?:^|__)computer_use_/u;

/**
 * Cookie import runs where the browser sessions are: in this process when the
 * host is the window's own, else in the kit's window half.
 */
const windowCookieImport = (callWindow: (command: string, input?: unknown) => Promise<unknown>): CookieImportWindow => process.type === "browser"
  ? { inProcess: true, call: async (command, input) => (await import("./view.js")).handleCookieImport(command.replace(/^cookie-/u, ""), input) }
  : { inProcess: false, call: callWindow };

/**
 * Preview Kit's host entry: one browser view over the Preview panel, its
 * commands for the panel, and the tools that let the agent look at what it
 * built. A host without a window answers every tool with one clear sentence.
 */
export function createPreviewHostExtension(
  createSurface: PreviewSurfaceFactory = electronSurface,
  cookieWindow: (callWindow: (command: string, input?: unknown) => Promise<unknown>) => CookieImportWindow = windowCookieImport,
  clearPartition: PreviewPartitionCleaner = electronPartitionCleaner,
): HostExtension {
  return {
    id: PREVIEW_HOST_EXTENSION_ID,
    name: "Preview",
    permissions: ["runtime:extend", "process", "network", "sessions"],
    async activate(context: HostExtensionContext) {
      const controller = new PreviewController(createSurface, clearPartition, context);
      // The defaults are the host's config for its workspace; no client sends them on load.
      let generation = 0;
      let workspace: string | undefined;
      const loadDefaults = async () => {
        const started = ++generation;
        const settings = await context.services.settings?.(workspace).catch(() => undefined);
        if (settings && started === generation) await controller.setDefaults(defaultsFromSettings(settings));
      };
      await loadDefaults();
      const stopConfig = context.services.observeConfigChanges((change) => { if (change.kind === "config") void loadDefaults().catch(() => undefined); });
      const stopLifecycle = context.services.registerThreadLifecycle({ beforeWorkspace: async (cwd) => { workspace = cwd; await loadDefaults().catch(() => undefined); } });
      context.registerCommand("open", (input) => controller.open((input as { url?: unknown } | undefined)?.url));
      context.registerCommand("navigate", (input) => controller.navigate(input));
      context.registerCommand("close", () => controller.close());
      context.registerCommand("bounds", (input) => { controller.setBounds(readPreviewBounds(input)); });
      context.registerCommand("state", () => controller.state(), { access: "read" });
      // The window half reports what the page did and the chords it took; core only routes them here.
      context.registerCommand("view-changed", (input) => controller.acceptRemoteState(input));
      const field = (input: unknown, key: string): unknown => input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
      context.registerCommand("view-chord", (input) => {
        const chord = field(input, "chord");
        if (chord === "reload" || chord === "hard-reload" || chord === "zoom-in" || chord === "zoom-out" || chord === "zoom-reset") return controller.chord(chord);
        throw new Error("Unknown preview chord.");
      });
      context.registerCommand("ports", (input) => controller.ports(field(input, "cwd")), { access: "read" });
      context.registerCommand("pick", () => controller.pick());
      context.registerCommand("pick-cancel", () => controller.cancelPick());
      context.registerCommand("annotate", (input) => controller.annotate(field(input, "tool")));
      context.registerCommand("annotate-cancel", () => controller.annotateCancel());
      context.registerCommand("annotate-send", () => controller.annotateSend());
      context.registerCommand("record-start", () => controller.recordStart());
      context.registerCommand("record-stop", () => controller.recordStop());
      context.registerCommand("profiles", () => controller.profileList(), { access: "read" });
      context.registerCommand("use-profile", (input) => controller.useProfile(field(input, "name")));
      context.registerCommand("rename-profile", (input) => controller.renameProfile(input));
      context.registerCommand("delete-profile", (input) => controller.deleteProfile(input));
      context.registerCommand("zoom", (input) => controller.setZoom(input));
      context.registerCommand("viewport", (input) => {
        const viewport = readViewport(input);
        if (!viewport) throw new Error("Not a viewport: fill, or a width and a height between 200 and 4000.");
        return controller.resize(viewport);
      });
      context.registerCommand("appearance", (input) => {
        const appearance = readAppearance(field(input, "appearance"));
        if (!appearance) throw new Error("Appearance is system, light or dark.");
        return controller.setAppearance(appearance);
      });
      context.registerCommand("defaults", (input) => { generation++; return controller.setDefaults(input); });
      context.registerCommand("current-defaults", () => controller.currentDefaults(), { access: "read" });
      context.registerCommand("history", () => controller.historyList(), { access: "read" });
      context.registerCommand("forget", (input) => controller.forget(input));
      context.registerCommand("mini-frame", () => controller.miniFrame(), { access: "read" });
      context.registerCommand("mini-prefs", (input) => controller.setMiniPrefs(input));
      context.registerCommand("mini-dismiss", () => controller.dismissMini());
      // A Read-only device gets frames at whatever layout the page has; `liveFrame` checks.
      context.registerCommand("live-frame", (input, call) => controller.liveFrame(input, call), { access: "read" });
      context.registerCommand("layout", (input, call) => controller.setLayout(input, call));
      // Decision 7: a device that shows the page may drive it; a Read-only one only watches.
      // A page that went away under a tap is the device's answer, not a broken kit.
      context.registerCommand("download", (input) => controller.download(String(field(input, "url") ?? ""), String(field(input, "destination") ?? "")));
      context.registerCommand("input", (input) => controller.input(input).catch((error: unknown) => {
        throw new HostCommandError(error instanceof Error ? error.message : String(error));
      }));
      // Only the panel's own dialog reaches these; no agent tool imports cookies.
      // Cookies go into the view's sessions, so into the window that holds the view.
      const cookies = new CookieImportHost(cookieWindow((command, input) => controller.windowCall(command, input)), {
        profiles: () => controller.profileList(),
        partition: profilePartition,
        reload: (profile) => controller.reloadIn(profile),
      });
      context.registerCommand("import-sources", () => cookies.sources());
      context.registerCommand("import-sites", (input) => cookies.sites(input));
      context.registerCommand("import-cookies", (input) => cookies.import(input));
      context.registerCommand("import-open-access", () => cookies.openAccess());
      context.registerCommand("hold", (input) => controller.hold(input));
      context.registerCommand("cookie-import-settled", (input) => { cookies.settle(input); });
      context.registerCommand("evidence-frame", (input) => {
        const width = field(input, "maxWidth");
        return controller.evidenceFrame(typeof width === "number" && width >= 160 && width <= 1_920 ? Math.round(width) : 960);
      }, { callers: [EVIDENCE_CALLER] });

      const factory: RuntimeExtensionFactory = (pi, session) => {
        controller.noteWorkspace(session.cwd);
        for (const tool of previewTools(controller, session.sessionId)) pi.registerTool(tool);
      };
      const release = context.services.registerRuntimeExtension("tau-preview", factory);
      // The same tools for the runtimes that are not Pi; the calling thread's workspace gates `file://`.
      const releaseMcp = context.services.mcp.registerTools((thread) => {
        controller.noteWorkspace(thread.cwd);
        return previewTools(controller, thread.sessionId);
      });
      // The floating preview follows whoever drives the page or a window, until that turn ends.
      const releaseObserver = context.services.registerTurnObserver({
        toolEnded: (sessionId, tool) => { if (DRIVES_A_WINDOW.test(tool.name)) controller.drive(sessionId, "screen"); },
        ended: async (sessionId) => controller.releaseDriver(sessionId),
        closed: async (sessionId) => controller.releaseDriver(sessionId),
      });
      return () => { stopConfig(); stopLifecycle(); release(); releaseMcp(); releaseObserver(); cookies.dispose(); controller.dispose(); };
    },
  };
}

export default createPreviewHostExtension;
