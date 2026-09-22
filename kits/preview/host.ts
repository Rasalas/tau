import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import type { HostExtension, HostExtensionContext, RuntimeExtensionFactory } from "tau/host-extension";
import {
  EMPTY_PREVIEW_STATE,
  PREVIEW_HOST_EXTENSION_ID,
  PREVIEW_STATE_EVENT,
  type PreviewBounds,
  type PreviewImage,
  type PreviewProfiles,
  type PreviewRecording,
  type PreviewServer,
  type PreviewState,
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
import { pickCrop, readAnnotationResult, readPickedElement } from "./picks.js";
import { probeHttp, scanPorts } from "./ports.js";
import { PreviewProfileStore, profilePartition } from "./profiles.js";
import {
  isPreviewRef,
  pageCall,
  previewClick,
  previewCondition,
  previewFind,
  previewScroll,
  previewSnapshot,
  previewType,
  type PreviewActionResult,
  type PreviewTarget,
} from "./page-script.js";

/** A tool of any shape, as the array of them and `registerTool` see it. */
// oxlint-disable-next-line typescript/no-explicit-any -- the SDK's own `AnyToolDefinition`, which it does not export.
type AnyTool = ToolDefinition<TSchema, any, any>;

/**
 * Pi's `defineTool` is identity, and a kit takes the SDK's types rather than
 * its module: importing the value would bundle the whole agent into the kit.
 */
const defineTool = <Params extends TSchema, Details = unknown>(tool: ToolDefinition<Params, Details>): AnyTool =>
  tool as unknown as AnyTool;

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
  place(rect: PreviewRect, visible: boolean): void;
  load(url: string, timeoutMs: number): Promise<void>;
  navigate(action: "back" | "forward" | "reload"): void;
  state(): PreviewState;
  viewport(): { width: number; height: number };
  /** `isolated` runs it in a world of its own, where the page's scripts cannot reach its state. */
  evaluate(expression: string, isolated?: boolean): Promise<unknown>;
  /** `rect`, in the page's CSS pixels, cuts the capture to that part of the view. */
  capture(maxWidth: number, rect?: PreviewRect): Promise<{ base64: string; width: number; height: number }>;
  /** A webm recording of the view: `take` answers the chunks since the last call, base64. */
  record(action: "start" | "take" | "stop"): Promise<PreviewRecordingChunks>;
  pressKey(key: string): void;
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
  /** Workspace of the thread being previewed; the only place `file://` may point into. */
  workspaceRoot(): string;
  log(label: string, detail?: string): void;
  /** Reaches this kit's window half, when the host has a client that holds one. */
  callClient?(command: string, input?: unknown): Promise<unknown>;
}

export type PreviewSurfaceFactory = (options: PreviewSurfaceOptions) => Promise<PreviewSurface | undefined>;

const LOAD_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 30_000;
const SCREENSHOT_MAX_WIDTH = 1_280;
const EVALUATE_MAX_CHARS = 20_000;
const NO_DESKTOP = "Preview needs the Tau desktop app on this host";
const PICK_POLL_MS = 200;
const PICK_TIMEOUT_MS = 5 * 60_000;
const PICK_IMAGE_MAX_WIDTH = 1_200;
const RECORDING_DRAIN_MS = 1_000;
const RECORDING_MAX_MS = 10 * 60_000;
const RECORDING_MAX_BYTES = 500 * 1024 * 1024;
const PORTS_FRESH_MS = 2_000;

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
}

/** A tool result that also carries Pi's error flag. */
type ToolAnswer = AgentToolResult<unknown> & { isError?: boolean };

const answer = (message: string): ToolAnswer => ({ content: [{ type: "text", text: message }], details: undefined });
const failure = (message: string): ToolAnswer => ({ content: [{ type: "text", text: message }], details: undefined, isError: true });

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
export function normalizePreviewUrl(input: unknown, workspaceRoot: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new Error("Preview needs a URL.");
  // `localhost:3000` is a host and a port, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(raw) && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/iu.test(raw);
  const candidate = raw.startsWith("/") ? `file://${raw}` : hasScheme ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Not a URL Preview can open: ${raw}`);
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  if (url.protocol === "about:" && url.pathname === "blank") return "about:blank";
  if (url.protocol !== "file:") throw new Error(`Preview opens http, https and workspace files only, not ${url.protocol}`);
  const path = decodeURIComponent(url.pathname);
  const root = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (!workspaceRoot || !path.startsWith(root)) throw new Error("Preview opens local files only inside the workspace.");
  return url.toString();
}

function target(params: { ref?: string; selector?: string; text?: string }, allowText: boolean): PreviewTarget {
  if (params.ref) {
    if (!isPreviewRef(params.ref)) throw new Error(`"${params.ref}" is not a ref; take a preview_snapshot first.`);
    return { ref: params.ref };
  }
  if (params.selector) return { selector: params.selector };
  if (allowText && params.text) return { text: params.text };
  throw new Error(allowText ? "Name the element by ref, selector or text." : "Name the element by ref or selector.");
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(signal.reason instanceof Error ? signal.reason.message : "Preview tool was cancelled.")), { once: true });
  });
}

/** Every tool stops at 30 s, and at whatever the runtime cancels first. */
async function bounded<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const guard = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
  return Promise.race([work(), aborted(guard)]);
}

function describeState(state: PreviewState, viewport?: { width: number; height: number }): string {
  const lines = [
    `url: ${state.url || "(nothing loaded)"}`,
    `title: ${state.title || "(untitled)"}`,
    `loading: ${state.loading}`,
    ...(viewport ? [`viewport: ${viewport.width}×${viewport.height}`] : []),
    `history: ${state.canGoBack ? "can go back" : "no back"}, ${state.canGoForward ? "can go forward" : "no forward"}`,
  ];
  if (state.consoleErrors.length > 0) lines.push(`console errors and failed requests (${state.consoleErrors.length}):`, ...state.consoleErrors.slice(-10).map((error) => `  ${error}`));
  return lines.join("\n");
}

/**
 * One preview per host: the view, the panel bounds it is placed by, and the
 * tools' access to it. Everything Electron is behind `PreviewSurface`.
 */
class PreviewController {
  private view: PreviewSurface | undefined;

  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };

  private lastPublished = "";

  private workspaceRoot = "";

  /** False once this host proved it has no window to draw in. */
  private available = true;

  private readonly profiles: PreviewProfileStore;

  private mode: PreviewState["mode"];

  /** Bumped whenever a pick is superseded, so its poll loop knows to stop. */
  private pickToken = 0;

  private recording: ActiveRecording | undefined;

  private recordingNotice: string | undefined;

  private shownUrl = "";

  private portScan: { at: number; cwd: string; servers: Promise<PreviewServer[]> } | undefined;

  constructor(
    private readonly createSurface: PreviewSurfaceFactory,
    private readonly context: HostExtensionContext,
  ) {
    this.profiles = new PreviewProfileStore(context.services.stateDir);
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
      workspaceRoot: () => this.workspaceRoot,
      log: (label, detail) => this.context.services.log(label, detail),
      callClient: (command, input) => this.context.services.callClient(command, input),
    });
    if (!created) {
      this.available = false;
      throw new Error(NO_DESKTOP);
    }
    this.view = created;
    created.place(previewRect(this.bounds, created.zoomFactor()), previewVisible(this.bounds));
    return created;
  }

  state(): PreviewState {
    const page = this.view?.state() ?? { ...EMPTY_PREVIEW_STATE, available: this.available };
    return {
      ...page,
      profile: this.profiles.snapshot().active,
      ...(this.mode ? { mode: this.mode } : {}),
      ...(this.recording ? { recordingSince: this.recording.since } : {}),
      ...(this.recordingNotice ? { recordingNotice: this.recordingNotice } : {}),
    };
  }

  setBounds(bounds: PreviewBounds): void {
    this.bounds = bounds;
    if (this.view) this.view.place(previewRect(bounds, this.view.zoomFactor()), previewVisible(bounds));
  }

  async close(): Promise<PreviewState> {
    this.pickToken += 1;
    this.mode = undefined;
    await this.recordStop().catch(() => null);
    this.view?.destroy();
    this.view = undefined;
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
    // A navigation took the annotation layer with the page it was drawn on.
    if (state.url !== this.shownUrl) {
      this.shownUrl = state.url;
      if (this.mode === "annotate") {
        this.mode = undefined;
        return this.publish();
      }
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
    if (step !== "back" && step !== "forward" && step !== "reload") throw new Error("preview_navigate needs a url or action back, forward or reload.");
    const surface = await this.surface();
    surface.navigate(step);
    this.publish();
    return surface.state();
  }

  /** Runs a snippet in the page; the tools never touch the surface directly. */
  async evaluate(expression: string): Promise<unknown> {
    return (await this.surface()).evaluate(expression);
  }

  private async page(verb: string): Promise<PreviewSurface> {
    const surface = await this.surface();
    if (!surface.state().url) throw new Error(`Open a page before ${verb}.`);
    return surface;
  }

  /**
   * Arms pick mode and waits for the user: the element they clicked with an
   * image of it, or `null` when they gave up, navigated or picked again.
   */
  async pick(): Promise<{ element: PreviewPickedElement; image?: PreviewImage } | null> {
    const surface = await this.page("picking an element");
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
    const surface = await this.page("annotating it");
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
    const surface = await this.page("annotating it");
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

  async recordStart(): Promise<PreviewState> {
    if (this.recording) return this.state();
    const surface = await this.page("recording it");
    const directory = join(this.context.services.stateDir, "recordings");
    await mkdir(directory, { recursive: true });
    const name = `preview-${new Date().toISOString().replace(/[:.]/gu, "-")}.webm`;
    const path = join(directory, name);
    const file = await open(path, "w");
    let started: PreviewRecordingChunks;
    try {
      started = await surface.record("start");
    } catch (error) {
      await file.close();
      throw error;
    }
    const timer = setInterval(() => this.drain(), RECORDING_DRAIN_MS);
    timer.unref?.();
    this.recordingNotice = undefined;
    this.recording = { surface, path, name, file, since: Date.now(), bytes: 0, mimeType: started.mimeType || "video/webm", timer, queue: Promise.resolve() };
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
      this.publish();
    }
    return { path: recording.path, name: recording.name, size: recording.bytes, durationMs: Date.now() - recording.since, mimeType: recording.mimeType.split(";")[0] || "video/webm" };
  }

  async profileList(): Promise<PreviewProfiles> {
    return this.profiles.read();
  }

  /** Another profile means another session, so the view is built again and the page reloaded in it. */
  async useProfile(name: unknown): Promise<PreviewProfiles> {
    const before = (await this.profiles.read()).active;
    const profiles = await this.profiles.use(name);
    if (profiles.active === before) return profiles;
    const url = this.view?.state().url ?? "";
    if (this.view) await this.close();
    if (url && url !== "about:blank") await this.open(url).catch(() => undefined);
    this.publish();
    return profiles;
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
    void this.close();
  }
}

function action(result: unknown, verb: string): ToolAnswer {
  const outcome = result as PreviewActionResult | undefined;
  if (!outcome?.ok) return failure(`${verb} failed: ${outcome?.error ?? "the page did not answer"}`);
  return answer(`${verb}: ${outcome.detail ?? "done"}`);
}

/** The tools the agent sees. Every one of them is sequential and bounded. */
function previewTools(controller: PreviewController): AnyTool[] {
  const sequential = { executionMode: "sequential" as const };
  const run = async (signal: AbortSignal | undefined, work: () => Promise<ToolAnswer>): Promise<ToolAnswer> => {
    try {
      return await bounded(signal, work);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };

  return [
    defineTool({
      name: "preview_open",
      label: "preview_open",
      description: "Open a URL in Tau's preview panel and wait for it to load. Use this to see the app you are working on; afterwards read it with preview_snapshot instead of guessing.",
      promptSnippet: "preview_open: show a URL in Tau's preview browser panel",
      parameters: Type.Object({ url: Type.String({ description: "http(s) URL, or an absolute path inside the workspace" }) }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const state = await controller.open(params.url);
        const surface = await controller.surface();
        return answer(`Preview opened.\n${describeState(state, surface.viewport())}`);
      }),
    }),
    defineTool({
      name: "preview_navigate",
      label: "preview_navigate",
      description: "Navigate the preview: load another URL, or go back, forward or reload.",
      promptSnippet: "preview_navigate: move the preview to another URL or through its history",
      parameters: Type.Object({
        url: Type.Optional(Type.String()),
        action: Type.Optional(Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")])),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => answer(describeState(await controller.navigate(params)))),
    }),
    defineTool({
      name: "preview_status",
      label: "preview_status",
      description: "What the preview currently shows: URL, title, loading state, viewport size and the last console errors and failed requests.",
      promptSnippet: "preview_status: URL, title, viewport and console errors of the preview",
      parameters: Type.Object({}),
      ...sequential,
      execute: (_id, _params, signal) => run(signal, async () => {
        const surface = await controller.surface();
        return answer(describeState(surface.state(), surface.viewport()));
      }),
    }),
    defineTool({
      name: "preview_snapshot",
      label: "preview_snapshot",
      description: "A compact text tree of the page: headings, visible text and every interactive element with a stable ref (e1, e2, …). Read this instead of taking a screenshot, and pass the refs to preview_click, preview_type and preview_scroll. Refs are renumbered by every snapshot.",
      promptSnippet: "preview_snapshot: read the preview page as a text tree with refs",
      parameters: Type.Object({ maxChars: Type.Optional(Type.Number({ description: "Cap on the tree, 8000 by default" })) }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const maxChars = Math.min(Math.max(Math.round(params.maxChars ?? 8_000), 500), 40_000);
        const tree = await controller.evaluate(pageCall(previewSnapshot, maxChars));
        return answer(typeof tree === "string" ? tree : "The page returned no snapshot.");
      }),
    }),
    defineTool({
      name: "preview_screenshot",
      label: "preview_screenshot",
      description: "A PNG of what the preview shows. Prefer preview_snapshot for reading content; take a screenshot when layout, styling or a visual bug is the question.",
      promptSnippet: "preview_screenshot: see the preview as an image",
      parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean({ description: "Reserved; the visible viewport is captured" })) }),
      ...sequential,
      execute: (_id, _params, signal) => run(signal, async () => {
        const surface = await controller.surface();
        const shot = await surface.capture(SCREENSHOT_MAX_WIDTH);
        return {
          content: [
            { type: "text" as const, text: `Preview screenshot of ${surface.state().url || "(nothing loaded)"} at ${shot.width}×${shot.height}.` },
            { type: "image" as const, data: shot.base64, mimeType: "image/png" },
          ],
          details: undefined,
        };
      }),
    }),
    defineTool({
      name: "preview_click",
      label: "preview_click",
      description: "Click an element of the previewed page, named by a snapshot ref, a CSS selector or its visible text.",
      promptSnippet: "preview_click: click an element in the preview by ref, selector or text",
      parameters: Type.Object({ ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () =>
        action(await controller.evaluate(pageCall(previewClick, previewFind, target(params, true))), "click")),
    }),
    defineTool({
      name: "preview_type",
      label: "preview_type",
      description: "Replace the text of an input, textarea or contenteditable in the preview. Set submit to press Enter afterwards, which submits the surrounding form.",
      promptSnippet: "preview_type: put text into a field of the preview",
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        text: Type.String(),
        submit: Type.Optional(Type.Boolean()),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () =>
        action(await controller.evaluate(pageCall(previewType, previewFind, target(params, false), params.text, params.submit === true)), "type")),
    }),
    defineTool({
      name: "preview_press",
      label: "preview_press",
      description: "Send a key to the previewed page, e.g. Enter, Tab, Escape, ArrowDown.",
      promptSnippet: "preview_press: send a key to the preview",
      parameters: Type.Object({ key: Type.String() }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const key = params.key.trim();
        if (!key) throw new Error("preview_press needs a key.");
        const surface = await controller.surface();
        surface.pressKey(key);
        return answer(`pressed ${key}`);
      }),
    }),
    defineTool({
      name: "preview_scroll",
      label: "preview_scroll",
      description: "Scroll the previewed page, or one scrollable element of it, by a pixel delta.",
      promptSnippet: "preview_scroll: scroll the preview page or one element",
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        dx: Type.Optional(Type.Number()),
        dy: Type.Optional(Type.Number()),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const scope = params.ref || params.selector ? target(params, false) : undefined;
        return action(await controller.evaluate(pageCall(previewScroll, previewFind, scope ?? null, params.dx ?? 0, params.dy ?? 400)), "scroll");
      }),
    }),
    defineTool({
      name: "preview_evaluate",
      label: "preview_evaluate",
      description: "Evaluate a JavaScript expression in the previewed page and return its JSON value. Use it for what the snapshot cannot say, e.g. computed styles or app state.",
      promptSnippet: "preview_evaluate: run a JavaScript expression in the preview and read its value",
      parameters: Type.Object({ expression: Type.String() }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const expression = params.expression.trim();
        if (!expression) throw new Error("preview_evaluate needs an expression.");
        const value = await controller.evaluate(`(async () => { try { return JSON.stringify(await (${expression}) ?? null); } catch (error) { return JSON.stringify({ error: String(error) }); } })()`);
        const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
        return answer(json.length > EVALUATE_MAX_CHARS ? `${json.slice(0, EVALUATE_MAX_CHARS)}\n… truncated at ${EVALUATE_MAX_CHARS} characters` : json);
      }),
    }),
    defineTool({
      name: "preview_wait_for",
      label: "preview_wait_for",
      description: "Wait until the preview shows a text, matches a selector or reaches a URL. Use it after an action that navigates or loads.",
      promptSnippet: "preview_wait_for: wait for text, a selector or a URL in the preview",
      parameters: Type.Object({
        text: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        if (!params.text && !params.selector && !params.urlIncludes) throw new Error("preview_wait_for needs text, a selector or urlIncludes.");
        const surface = await controller.surface();
        const deadline = Date.now() + Math.min(Math.max(Math.round(params.timeoutMs ?? 10_000), 100), TOOL_TIMEOUT_MS - 1_000);
        for (;;) {
          const urlMatches = !params.urlIncludes || surface.state().url.includes(params.urlIncludes);
          const pageMatches = !params.text && !params.selector
            ? true
            : await surface.evaluate(pageCall(previewCondition, params.text ?? null, params.selector ?? null)) === true;
          if (urlMatches && pageMatches) return answer(`condition met at ${surface.state().url}`);
          if (Date.now() >= deadline) return failure(`preview_wait_for timed out at ${surface.state().url}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }),
    }),
  ];
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

/**
 * Preview Kit's host entry: one browser view over the Preview panel, its
 * commands for the panel, and the tools that let the agent look at what it
 * built. A host without a window answers every tool with one clear sentence.
 */
export function createPreviewHostExtension(createSurface: PreviewSurfaceFactory = electronSurface): HostExtension {
  return {
    id: PREVIEW_HOST_EXTENSION_ID,
    name: "Preview",
    permissions: ["runtime:extend", "process", "network"],
    activate(context: HostExtensionContext) {
      const controller = new PreviewController(createSurface, context);
      context.registerCommand("open", (input) => controller.open((input as { url?: unknown } | undefined)?.url));
      context.registerCommand("navigate", (input) => controller.navigate(input));
      context.registerCommand("close", () => controller.close());
      context.registerCommand("bounds", (input) => { controller.setBounds(readPreviewBounds(input)); });
      context.registerCommand("state", () => controller.state());
      // The window half reports what the page did; core only routes it here.
      context.registerCommand("view-changed", (input) => controller.acceptRemoteState(input));
      const field = (input: unknown, key: string): unknown => input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
      context.registerCommand("ports", (input) => controller.ports(field(input, "cwd")));
      context.registerCommand("pick", () => controller.pick());
      context.registerCommand("pick-cancel", () => controller.cancelPick());
      context.registerCommand("annotate", (input) => controller.annotate(field(input, "tool")));
      context.registerCommand("annotate-cancel", () => controller.annotateCancel());
      context.registerCommand("annotate-send", () => controller.annotateSend());
      context.registerCommand("record-start", () => controller.recordStart());
      context.registerCommand("record-stop", () => controller.recordStop());
      context.registerCommand("profiles", () => controller.profileList());
      context.registerCommand("use-profile", (input) => controller.useProfile(field(input, "name")));

      const factory: RuntimeExtensionFactory = (pi, session) => {
        controller.noteWorkspace(session.cwd);
        for (const tool of previewTools(controller)) pi.registerTool(tool);
      };
      const release = context.services.registerRuntimeExtension("tau-preview", factory);
      return () => { release(); controller.dispose(); };
    },
  };
}

export default createPreviewHostExtension;
