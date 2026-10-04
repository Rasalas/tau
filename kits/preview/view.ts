import { BrowserWindow, WebContentsView, nativeImage, session, shell, type Debugger, type NativeImage } from "electron";
import { sep } from "node:path";
import { downloadPreviewFile } from "./download.js";
import { EMPTY_PREVIEW_STATE, type PreviewAppearance, type PreviewChord, type PreviewState } from "./protocol.js";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import type { PreviewRect, PreviewSurface, PreviewSurfaceOptions } from "./host.js";
import type { PreviewSnapshot } from "./remote-surface.js";
import { PreviewRecorder } from "./recorder.js";
import { previewChord } from "./viewport.js";
import { cdpInputCommands, type PreviewPageInput } from "./remote-input.js";
import { placePreviewView } from "./view-placement.js";
import type { PreviewDeviceMetrics } from "./device-layout.js";
import { PREVIEW_WINDOW_UNAVAILABLE } from "./window-availability.js";

/** Cookies and storage of previewed sites stay out of the workbench's own session. */
const DEFAULT_PARTITION = "persist:tau-preview";
const MAX_ERRORS = 50;
/** Pick and annotate run here, apart from the page's own scripts. */
const ISOLATED_WORLD = 1_022;
/** A page that never answers a screenshot is a skipped frame, not a stuck device. */
const HIDDEN_CAPTURE_TIMEOUT_MS = 5_000;
/** A view hidden in a window that paints answers only every other screenshot; the next request frees it. */
const HIDDEN_CAPTURE_NUDGE_MS = 400;

/** The part of a full-view image under `rect`, which is in the view's coordinates like `capturePage`'s. */
export function cropToView(image: NativeImage, viewWidth: number, rect?: PreviewRect): NativeImage {
  if (!rect) return image;
  const size = image.getSize();
  const scale = viewWidth > 0 ? size.width / viewWidth : 1;
  const x = Math.min(size.width - 1, Math.max(0, Math.round(rect.x * scale)));
  const y = Math.min(size.height - 1, Math.max(0, Math.round(rect.y * scale)));
  const width = Math.max(1, Math.min(size.width - x, Math.round(rect.width * scale)));
  const height = Math.max(1, Math.min(size.height - y, Math.round(rect.height * scale)));
  return image.crop({ x, y, width, height });
}

/**
 * DevTools' device metrics for a device's layout. Chromium sizes the view's
 * surface to the device's screen whatever its bounds, so such a page is only
 * ever drawn off screen and seen through its pictures.
 */
export function deviceOverride(device: PreviewDeviceMetrics): Record<string, unknown> {
  return {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.dpr,
    // A phone's browser: the page's `<meta name="viewport">` counts, scrollbars overlay.
    mobile: device.touch,
    screenWidth: device.width,
    screenHeight: device.height,
  };
}

/** Forgets a deleted profile's cookies, storage and cache; only a preview partition is touched. */
export async function clearPreviewPartition(partition: string): Promise<void> {
  if (!partition.startsWith(`${DEFAULT_PARTITION}-`)) throw new Error(`Not a preview profile's partition: ${partition}`);
  const target = session.fromPartition(partition);
  await target.clearStorageData();
  await target.clearCache();
}

/** A preview may read the workspace it belongs to, and nothing else on the disk. */
export function fileUrlAllowed(url: string, workspaceRoot: string): boolean {
  if (!url.startsWith("file://")) return true;
  if (!workspaceRoot) return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }
  const root = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  return path.startsWith(root);
}

/**
 * The preview browser: one `WebContentsView` over the panel, in its own
 * session, with no Node, no device permissions and no way out of the
 * workspace on `file://`.
 */
export function createElectronPreviewSurface(options: PreviewSurfaceOptions, window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]): PreviewSurface | undefined {
  if (!window || window.isDestroyed()) return undefined;

  // A profile is a partition: its own cookies, storage and cache.
  const partition = options.partition || DEFAULT_PARTITION;
  const previewSession = session.fromPartition(partition);
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) =>
    callback({ cancel: !fileUrlAllowed(details.url, options.workspaceRoot()) }));

  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  const contents = view.webContents;
  view.setBackgroundColor("#ffffff");
  view.setVisible(false);
  window.contentView.addChildView(view);
  const placement = placePreviewView(window, view);

  const errors: string[] = [];
  let destroyed = false;
  let recorder: PreviewRecorder | undefined;
  let pageZoom = 1;
  let appearance: PreviewAppearance = "system";
  const note = (message: string): void => {
    errors.push(message.slice(0, 400));
    if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
  };
  const changed = (): void => { if (!destroyed) options.onChange(); };

  contents.setWindowOpenHandler(({ url }) => {
    // A popup would have no place in the panel; the browser is the honest home for it.
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!fileUrlAllowed(url, options.workspaceRoot())) {
      event.preventDefault();
      note(`blocked navigation outside the workspace: ${url}`);
    }
  });
  // Chromium keeps zoom per origin; the preview's zoom is the view's, so it follows every navigation.
  const applyZoom = () => {
    if (!contents.isDestroyed() && Math.abs(contents.getZoomFactor() - pageZoom) > 0.001) contents.setZoomFactor(pageZoom);
  };
  const devTools = (): Debugger => {
    const tools = contents.debugger;
    if (!tools.isAttached()) tools.attach("1.3");
    return tools;
  };
  let focusEmulated = false;
  // A device's layout; commands to the page wait until it is applied.
  let device: PreviewDeviceMetrics | undefined;
  let deviceKey = "";
  let emulation: Promise<void> = Promise.resolve();
  let placing = 0;
  const emulate = async (next: PreviewDeviceMetrics | undefined): Promise<void> => {
    if (contents.isDestroyed()) return;
    if (!next) {
      if (!contents.debugger.isAttached()) return;
      await contents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      await contents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
      return;
    }
    const tools = devTools();
    await tools.sendCommand("Emulation.setDeviceMetricsOverride", deviceOverride(next));
    await tools.sendCommand("Emulation.setTouchEmulationEnabled", next.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  };
  const inputTools = async (): Promise<Debugger> => {
    await emulation;
    const tools = devTools();
    if (!focusEmulated) {
      // The page must think it has focus, or a field it focuses drops the typed text.
      await tools.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      focusEmulated = true;
    }
    return tools;
  };
  // DevTools-protocol input is trusted and reaches a hidden view without taking the window's focus.
  let inputTail: Promise<void> = Promise.resolve();
  const sendInput = (input: PreviewPageInput): Promise<void> => {
    const sent = inputTail.then(async () => {
      if (destroyed) throw new Error("The preview is closed.");
      const tools = await inputTools();
      for (const [method, params] of cdpInputCommands(input, { touch: device?.touch === true })) await tools.sendCommand(method, params);
    });
    // One rejected input must not poison later input, and a click's down/up stay together.
    inputTail = sent.catch(() => undefined);
    return sent;
  };
  const applyAppearance = async (): Promise<void> => {
    const tools = contents.debugger;
    if (appearance === "system" && !tools.isAttached()) return;
    await devTools().sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: appearance === "system" ? "" : appearance }] });
  };
  contents.on("did-navigate", () => {
    applyZoom();
    void applyAppearance().catch((error: unknown) => note(`appearance: ${error instanceof Error ? error.message : String(error)}`));
  });
  // The page's ⌘R and zoom chords are the page's; `preventDefault` also keeps the app menu's from firing.
  contents.on("before-input-event", (event, input) => {
    const chord = previewChord(input, process.platform);
    if (!chord || !options.onChord) return;
    event.preventDefault();
    options.onChord(chord);
  });
  contents.on("did-start-loading", () => { errors.length = 0; changed(); });
  contents.on("did-stop-loading", changed);
  contents.on("page-title-updated", changed);
  contents.on("did-navigate-in-page", changed);
  contents.on("console-message", (details) => {
    if (details.level !== "error") return;
    note(`console: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    changed();
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (code === -3) return;
    note(`${isMainFrame ? "page" : "request"} failed: ${description} (${code}) ${url}`);
    changed();
  });
  // `capturePage` rejects a view that was never on screen and lags a frame behind a hidden one;
  // the protocol's screenshot makes the page paint for it and leaves it hidden.
  const captureHidden = async (rect?: PreviewRect, jpeg?: boolean): Promise<NativeImage> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The hidden page did not paint.")), HIDDEN_CAPTURE_TIMEOUT_MS);
    });
    const params = jpeg ? { format: "jpeg", quality: 90 } : { format: "png" };
    const request = () => devTools().sendCommand("Page.captureScreenshot", params) as Promise<{ data: string }>;
    let nudge: ReturnType<typeof setTimeout> | undefined;
    const nudged = new Promise<{ data: string }>((resolve, reject) => {
      nudge = setTimeout(() => { request().then(resolve, reject); }, HIDDEN_CAPTURE_NUDGE_MS);
    });
    const { data } = await Promise.race([request(), nudged, timeout]).finally(() => {
      clearTimeout(timer);
      clearTimeout(nudge);
    });
    return cropToView(nativeImage.createFromBuffer(Buffer.from(data, "base64")), device?.width ?? view.getBounds().width, rect);
  };
  const closeWithWindow = () => surface.destroy();
  window.once("closed", closeWithWindow);

  const surface: PreviewSurface = {
    zoomFactor: () => window.isDestroyed() ? 1 : window.webContents.getZoomFactor(),
    place(rect: PreviewRect, asked: boolean, next?: PreviewDeviceMetrics) {
      if (destroyed) return;
      // Laid out for a device, the page is never drawn in the window: Chromium would size it past the panel.
      const visible = asked && !next;
      const key = next ? JSON.stringify(next) : "";
      if (key === deviceKey) {
        placement.place(rect, visible, device !== undefined);
        return;
      }
      deviceKey = key;
      device = next;
      const token = ++placing;
      emulation = emulation.then(() => emulate(next)).catch((error: unknown) => note(`device layout: ${error instanceof Error ? error.message : String(error)}`));
      // Shown only once the page has the layout for it, so the window never draws the other one.
      void emulation.then(() => { if (!destroyed && token === placing) placement.place(rect, visible, next !== undefined); });
      if (!visible) placement.place(rect, visible, next !== undefined);
    },
    async load(url: string, timeoutMs: number) {
      const settled = new Promise<void>((resolve) => {
        const done = () => {
          contents.off("did-finish-load", done);
          contents.off("did-fail-load", done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        contents.once("did-finish-load", done);
        contents.once("did-fail-load", done);
      });
      // `loadURL` rejects on an aborted load; the listeners above report it.
      contents.loadURL(url).catch((error: unknown) => note(`load failed: ${error instanceof Error ? error.message : String(error)}`));
      await settled;
      changed();
    },
    navigate(action) {
      if (action === "reload") contents.reload();
      else if (action === "hard-reload") contents.reloadIgnoringCache();
      else if (action === "back") contents.navigationHistory.goBack();
      else contents.navigationHistory.goForward();
    },
    setZoom(factor: number) {
      if (destroyed || !Number.isFinite(factor) || factor <= 0) return;
      pageZoom = factor;
      applyZoom();
    },
    async setAppearance(next: PreviewAppearance) {
      if (destroyed) return;
      appearance = next;
      try {
        await applyAppearance();
      } catch (error) {
        throw new Error(`The page's appearance could not be set: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    },
    state(): PreviewState {
      if (destroyed) return { ...EMPTY_PREVIEW_STATE };
      return {
        ...EMPTY_PREVIEW_STATE,
        url: contents.getURL(),
        title: contents.getTitle(),
        loading: contents.isLoading(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        consoleErrors: [...errors],
        available: true,
      };
    },
    viewport() {
      if (device) return { width: device.width, height: device.height };
      const bounds = view.getBounds();
      const zoom = contents.isDestroyed() ? 1 : contents.getZoomFactor();
      return { width: Math.round(bounds.width / zoom), height: Math.round(bounds.height / zoom) };
    },
    async evaluate(expression: string, isolated?: boolean) {
      if (isolated) return contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: expression }], true);
      await inputTools();
      return contents.executeJavaScript(expression, true);
    },
    async capture(maxWidth: number, rect?: PreviewRect, jpeg?: boolean) {
      await emulation;
      // A view on screen shows a device's layout scaled; the protocol's screenshot has it at its own size.
      const image = placement.onScreen() && !device ? await (rect ? contents.capturePage(rect) : contents.capturePage()) : await captureHidden(rect, jpeg);
      const size = image.getSize();
      const scaled = size.width > maxWidth
        ? image.resize({ width: maxWidth, height: Math.max(1, Math.round(size.height * (maxWidth / size.width))), quality: jpeg ? "better" : "good" })
        : image;
      const final = scaled.getSize();
      return { base64: (jpeg ? scaled.toJPEG(72) : scaled.toPNG()).toString("base64"), width: final.width, height: final.height };
    },
    async record(action, recordOptions) {
      if (destroyed) throw new Error("The preview is closed.");
      if (action === "start") {
        recorder ??= new PreviewRecorder(contents, recordOptions);
        return recorder.start();
      }
      const active = recorder;
      if (!active) return { chunks: [], mimeType: "video/webm" };
      if (action === "take") return active.take();
      recorder = undefined;
      return active.stop();
    },
    async input(event: PreviewPageInput) {
      if (destroyed) throw new Error("The preview is closed.");
      try {
        await sendInput(event);
      } catch (error) {
        throw new Error(`The page did not take the input: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    },
    async pressKey(key: string) {
      await surface.input!({ kind: "key", key });
    },
    download: (url, destination) => downloadPreviewFile(previewSession, partition, options.workspaceRoot(), url, destination),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      recorder?.dispose();
      recorder = undefined;
      if (contents.debugger.isAttached()) contents.debugger.detach();
      window.off("closed", closeWithWindow);
      placement.destroy();
      if (!contents.isDestroyed()) contents.close();
      options.log("preview.closed");
    },
  };
  options.log("preview.opened", partition);
  return surface;
}

/** Where System Settings grants Full Disk Access, which Safari's cookie file needs. */
const FULL_DISK_ACCESS_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/**
 * Cookie import runs here, in the process that owns the preview's sessions and
 * sits on the user's machine: decrypted values go into the session and never
 * travel to the host.
 */
export async function handleCookieImport(command: string, input?: unknown): Promise<unknown> {
  if (command === "open-access") {
    if (process.platform === "darwin") await shell.openExternal(FULL_DISK_ACCESS_SETTINGS);
    return undefined;
  }
  const { cookieImportEnvironment, runCookieImportCommand } = await import("./cookie-import.js");
  const environment = cookieImportEnvironment((partition) => {
    const { cookies } = session.fromPartition(partition);
    return { set: (cookie) => cookies.set(cookie), flushStore: () => cookies.flushStore() };
  });
  return runCookieImportCommand(command, input, environment);
}

function readDevice(value: unknown): PreviewDeviceMetrics | undefined {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (!fields) return undefined;
  const [width, height, dpr] = [fields.width, fields.height, fields.dpr].map((part) => typeof part === "number" && Number.isFinite(part) && part > 0 ? part : Number.NaN);
  if ([width, height, dpr].some(Number.isNaN)) return undefined;
  return { width: Math.round(width!), height: Math.round(height!), dpr: dpr!, touch: fields.touch === true };
}

function readRect(value: unknown): PreviewRect | undefined {
  const rect = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (!rect) return undefined;
  const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height].map((part) => typeof part === "number" && Number.isFinite(part) ? Math.round(part) : Number.NaN);
  if ([x, y, width, height].some(Number.isNaN) || width! < 1 || height! < 1) return undefined;
  return { x: x!, y: y!, width: width!, height: height! };
}

/** What the window half answers with: the state the host caches between calls. */
function snapshot(surface: PreviewSurface, result?: unknown): PreviewSnapshot {
  return {
    state: surface.state(),
    viewport: surface.viewport(),
    zoomFactor: surface.zoomFactor(),
    ...(result === undefined ? {} : { result }),
  };
}

/**
 * Preview Kit's window half: the part that needs the process the user's window
 * runs in, because a `WebContentsView` belongs to a window (ADR 0021). The
 * host half drives it through `callClient`; every answer carries the page's
 * state back, and a change between calls is reported with `view-changed`.
 */
export default function activatePreviewWindowHalf(context: WindowExtensionContext): WindowExtension {
  let surface: PreviewSurface | undefined;
  let partition = DEFAULT_PARTITION;
  let workspaceRoot = "";
  let owner: BrowserWindow | undefined;

  const open = (): PreviewSurface => {
    // On macOS the window process and its host connection outlive the window.
    // Its old surface was destroyed by `closed`; do not return that cached object.
    if (owner?.isDestroyed()) {
      surface = undefined;
      owner = undefined;
    }
    if (surface) return surface;
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const created = createElectronPreviewSurface({
      partition,
      onChange: () => {
        if (surface) void context.invokeHost("view-changed", snapshot(surface)).catch(() => undefined);
      },
      onChord: (chord: PreviewChord) => { void context.invokeHost("view-chord", { chord }).catch(() => undefined); },
      workspaceRoot: () => workspaceRoot,
      log: (label, detail) => context.log(label, detail),
    }, window);
    if (!created) throw new Error(PREVIEW_WINDOW_UNAVAILABLE);
    owner = window;
    surface = created;
    return created;
  };

  const fields = (input: unknown): Record<string, unknown> =>
    input && typeof input === "object" ? input as Record<string, unknown> : {};

  return {
    handle(command: string, input?: unknown): unknown {
      // Before the view's own handling: an import names a partition without switching the view to it.
      if (command === "cookie-import-start") {
        // It may wait on the keychain longer than a client call lives; the result is reported back.
        const job = fields(input).job;
        void handleCookieImport("import", input).then(
          (result) => context.invokeHost("cookie-import-settled", { job, result }),
          (error: unknown) => context.invokeHost("cookie-import-settled", { job, error: error instanceof Error ? error.message : String(error) }),
        ).catch(() => undefined);
        return { started: true };
      }
      if (command.startsWith("cookie-")) return handleCookieImport(command.slice("cookie-".length), input);
      const options = fields(input);
      if (typeof options.workspaceRoot === "string") workspaceRoot = options.workspaceRoot;
      // Another profile needs a view in another session; the host reloads the page in it.
      if (typeof options.partition === "string" && options.partition && options.partition !== partition) {
        partition = options.partition;
        surface?.destroy();
        surface = undefined;
      }
      switch (command) {
        case "open-view":
          return snapshot(open());
        case "place":
          open().place(options.rect as PreviewRect, options.visible === true, readDevice(options.device));
          return snapshot(open());
        case "load":
          return open().load(String(options.url ?? ""), Number(options.timeoutMs ?? 15_000)).then(() => snapshot(surface!));
        case "navigate":
          open().navigate(options.action as "back" | "forward" | "reload" | "hard-reload");
          return snapshot(open());
        case "zoom":
          open().setZoom(Number(options.factor ?? 1));
          return snapshot(open());
        case "appearance":
          return open().setAppearance(options.appearance === "light" || options.appearance === "dark" ? options.appearance : "system").then(() => snapshot(surface!));
        case "clear-partition":
          return clearPreviewPartition(String(options.target ?? ""));
        case "evaluate":
          return open().evaluate(String(options.expression ?? ""), options.isolated === true).then((result) => snapshot(surface!, result));
        case "download":
          return open().download!(String(options.url ?? ""), String(options.destination ?? "")).then((result) => snapshot(surface!, result));
        case "capture":
          return open().capture(Number(options.maxWidth ?? 1_280), readRect(options.rect), options.jpeg === true).then((result) => snapshot(surface!, result));
        case "record": {
          const action = options.action === "start" || options.action === "stop" ? options.action : "take";
          const frameRate = typeof options.frameRate === "number" ? options.frameRate : undefined;
          return open().record(action, frameRate === undefined ? undefined : { frameRate }).then((result) => snapshot(surface!, result));
        }
        case "input":
          return open().input!(options.event as PreviewPageInput).then(() => snapshot(surface!));
        case "press-key":
          return Promise.resolve(open().pressKey(String(options.key ?? ""))).then(() => snapshot(surface!));
        case "destroy": {
          const answer = surface ? snapshot(surface) : undefined;
          surface?.destroy();
          surface = undefined;
          return answer;
        }
        default:
          throw new Error(`Preview's window half has no command "${command}".`);
      }
    },
    dispose() {
      surface?.destroy();
      surface = undefined;
    },
  };
}
