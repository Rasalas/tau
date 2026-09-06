import { BrowserWindow, WebContentsView, session, shell } from "electron";
import { sep } from "node:path";
import type { PreviewState } from "../../shared/preview-protocol.js";
import type { PreviewRect, PreviewSurface, PreviewSurfaceOptions } from "./preview-host-extension.js";

/** Cookies and storage of previewed sites stay out of the workbench's own session. */
const PARTITION = "persist:tau-preview";
const MAX_ERRORS = 50;

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

  const previewSession = session.fromPartition(PARTITION);
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) =>
    callback({ cancel: !fileUrlAllowed(details.url, options.workspaceRoot()) }));

  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
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
      if (destroyed) return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, consoleErrors: [], available: true };
      return {
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
    evaluate: (expression: string) => contents.executeJavaScript(expression, true),
    async capture(maxWidth: number) {
      const image = await contents.capturePage();
      const size = image.getSize();
      const scaled = size.width > maxWidth
        ? image.resize({ width: maxWidth, height: Math.max(1, Math.round(size.height * (maxWidth / size.width))), quality: "good" })
        : image;
      const final = scaled.getSize();
      return { base64: scaled.toPNG().toString("base64"), width: final.width, height: final.height };
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
      window.off("closed", closeWithWindow);
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close();
      options.log("preview.closed");
    },
  };
  options.log("preview.opened", PARTITION);
  return surface;
}
