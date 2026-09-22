import { BrowserWindow, WebContentsView, session, shell } from "electron";
import { sep } from "node:path";
import { EMPTY_PREVIEW_STATE, type PreviewState } from "./protocol.js";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import type { PreviewRect, PreviewSurface, PreviewSurfaceOptions } from "./host.js";
import type { PreviewSnapshot } from "./remote-surface.js";
import { PreviewRecorder } from "./recorder.js";

/** Cookies and storage of previewed sites stay out of the workbench's own session. */
const DEFAULT_PARTITION = "persist:tau-preview";
const MAX_ERRORS = 50;
/** Pick and annotate run here, apart from the page's own scripts. */
const ISOLATED_WORLD = 1_022;

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
export function createElectronPreviewSurface(options: PreviewSurfaceOptions): PreviewSurface | undefined {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
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

  const errors: string[] = [];
  let destroyed = false;
  let recorder: PreviewRecorder | undefined;
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
  const closeWithWindow = () => surface.destroy();
  window.once("closed", closeWithWindow);

  const surface: PreviewSurface = {
    zoomFactor: () => window.isDestroyed() ? 1 : window.webContents.getZoomFactor(),
    place(rect: PreviewRect, visible: boolean) {
      if (destroyed) return;
      view.setBounds(rect);
      view.setVisible(visible);
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
      else if (action === "back") contents.navigationHistory.goBack();
      else contents.navigationHistory.goForward();
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
      const bounds = view.getBounds();
      const zoom = surface.zoomFactor();
      return { width: Math.round(bounds.width / zoom), height: Math.round(bounds.height / zoom) };
    },
    evaluate: (expression: string, isolated?: boolean) => isolated
      ? contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: expression }], true)
      : contents.executeJavaScript(expression, true),
    async capture(maxWidth: number, rect?: PreviewRect) {
      const image = rect ? await contents.capturePage(rect) : await contents.capturePage();
      const size = image.getSize();
      const scaled = size.width > maxWidth
        ? image.resize({ width: maxWidth, height: Math.max(1, Math.round(size.height * (maxWidth / size.width))), quality: "good" })
        : image;
      const final = scaled.getSize();
      return { base64: scaled.toPNG().toString("base64"), width: final.width, height: final.height };
    },
    async record(action) {
      if (destroyed) throw new Error("The preview is closed.");
      if (action === "start") {
        recorder ??= new PreviewRecorder(contents);
        return recorder.start();
      }
      const active = recorder;
      if (!active) return { chunks: [], mimeType: "video/webm" };
      if (action === "take") return active.take();
      recorder = undefined;
      return active.stop();
    },
    pressKey(key: string) {
      contents.focus();
      contents.sendInputEvent({ type: "keyDown", keyCode: key });
      if (key.length === 1) contents.sendInputEvent({ type: "char", keyCode: key });
      contents.sendInputEvent({ type: "keyUp", keyCode: key });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      recorder?.dispose();
      recorder = undefined;
      window.off("closed", closeWithWindow);
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close();
      options.log("preview.closed");
    },
  };
  options.log("preview.opened", partition);
  return surface;
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

  const open = (): PreviewSurface => {
    if (surface) return surface;
    const created = createElectronPreviewSurface({
      partition,
      onChange: () => {
        if (surface) void context.invokeHost("view-changed", snapshot(surface)).catch(() => undefined);
      },
      workspaceRoot: () => workspaceRoot,
      log: (label, detail) => context.log(label, detail),
    });
    if (!created) throw new Error("This window cannot draw a preview.");
    surface = created;
    return created;
  };

  const fields = (input: unknown): Record<string, unknown> =>
    input && typeof input === "object" ? input as Record<string, unknown> : {};

  return {
    handle(command: string, input?: unknown): unknown {
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
          open().place(options.rect as PreviewRect, options.visible === true);
          return snapshot(open());
        case "load":
          return open().load(String(options.url ?? ""), Number(options.timeoutMs ?? 15_000)).then(() => snapshot(surface!));
        case "navigate":
          open().navigate(options.action as "back" | "forward" | "reload");
          return snapshot(open());
        case "evaluate":
          return open().evaluate(String(options.expression ?? ""), options.isolated === true).then((result) => snapshot(surface!, result));
        case "capture":
          return open().capture(Number(options.maxWidth ?? 1_280), readRect(options.rect)).then((result) => snapshot(surface!, result));
        case "record": {
          const action = options.action === "start" || options.action === "stop" ? options.action : "take";
          return open().record(action).then((result) => snapshot(surface!, result));
        }
        case "press-key":
          open().pressKey(String(options.key ?? ""));
          return snapshot(open());
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
