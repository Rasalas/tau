import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PreviewBrowserProcess } from "./browser-process.js";
import { previewFileAllowed, savePreviewDownload } from "./headless-files.js";
import type { PreviewSurface, PreviewSurfaceOptions } from "./host.js";
import { EMPTY_PREVIEW_STATE, type PreviewState } from "./protocol.js";
import { cdpInputCommands } from "./remote-input.js";

/** The program is shared; user data is always Preview's own, never Chrome's. */
export function previewBrowserCommand(find: (name: string) => string | undefined): string | undefined {
  if (process.env.TAU_PREVIEW_BROWSER) return process.env.TAU_PREVIEW_BROWSER;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const installed = find(name);
    if (installed) return installed;
  }
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...(process.env.PROGRAMFILES ? [join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe")] : []),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")] : []),
  ].find((path) => existsSync(path));
}

function profilePath(stateDir: string, partition: string): string {
  if (!stateDir || !/^persist:tau-preview(?:-[a-z0-9-]{1,32})?$/u.test(partition)) throw new Error("Not a Preview profile.");
  return join(stateDir, "browser-profiles", partition.slice("persist:".length));
}

/** Only called once the active surface has stopped using its profile. */
export async function clearHeadlessPreviewProfile(stateDir: string, partition: string): Promise<void> {
  if (partition === "persist:tau-preview") throw new Error("The default profile cannot be deleted.");
  await rm(profilePath(stateDir, partition), { recursive: true, force: true });
}

/** A headless Chromium page behind the same interface as the desktop view. */
export async function createHeadlessPreviewSurface(options: PreviewSurfaceOptions, executable: string, stateDir: string): Promise<PreviewSurface> {
  const profile = profilePath(stateDir, options.partition);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const browser = new PreviewBrowserProcess(executable, profile);
  let destroyed = false;
  let closing: Promise<void> | undefined;
  let pageSession = "";
  let pageTarget = "";
  let width = 1280, height = 800, zoom = 1;
  let dpr = 1;
  let touch = false;
  let emulation: Promise<unknown> = Promise.resolve();
  let snapshot: PreviewState = { ...EMPTY_PREVIEW_STATE, available: true, surface: "headless", consoleErrors: [] };
  const send = <T = Record<string, unknown>>(method: string, params: object = {}) => browser.send<T>(method, params, pageSession);
  const note = (message: string) => {
    snapshot = { ...snapshot, consoleErrors: [...snapshot.consoleErrors, message.slice(0, 4_000)].slice(-50) };
    options.onChange();
  };
  const run = (work: Promise<unknown>) => { void work.catch((error: unknown) => { if (!destroyed) note(error instanceof Error ? error.message : String(error)); }); };
  const emulate = () => {
    // Page zoom changes the CSS viewport and its pixel density together.
    const metrics = { width: Math.round(width / zoom), height: Math.round(height / zoom), deviceScaleFactor: dpr * zoom, mobile: touch };
    const enabled = touch;
    emulation = emulation.then(async () => {
      await send("Emulation.setDeviceMetricsOverride", metrics);
      await send("Emulation.setTouchEmulationEnabled", { enabled });
    });
    run(emulation);
  };
  const refresh = async () => {
    const facts = await send<{ result: { value: { url: string; title: string } } }>("Runtime.evaluate", { expression: "({url:location.href,title:document.title})", returnByValue: true });
    const history = await send<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory");
    snapshot = { ...snapshot, ...facts.result.value, canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
    options.onChange();
  };
  const isolatedContext = async (): Promise<number> => {
    const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const world = await send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "tau-preview" });
    return world.executionContextId;
  };
  const evaluate = async (expression: string, isolated = false): Promise<unknown> => {
    await emulation;
    const result = await send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
      ...(isolated ? { contextId: await isolatedContext() } : {}),
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  browser.onEvent((event) => {
    if (event.method === "Target.attachedToTarget") {
      // Pause popups before their scripts can execute; Preview owns one page.
      const target = event.params.targetInfo as { targetId: string; type: string };
      if (target.targetId === pageTarget) return;
      if (target.type === "page") run(browser.send("Target.closeTarget", { targetId: target.targetId }));
      else if (typeof event.params.sessionId === "string") run(browser.send("Runtime.runIfWaitingForDebugger", {}, event.params.sessionId));
      return;
    }
    if (event.sessionId !== pageSession) return;
    if (event.method === "Fetch.requestPaused") {
      const request = event.params.request as { url: string };
      run(previewFileAllowed(request.url, options.workspaceRoot()).then((allowed) => send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
        requestId: event.params.requestId, ...(!allowed ? { errorReason: "AccessDenied" } : {}),
      })));
    }
    if (event.method === "Page.frameStartedLoading") { snapshot = { ...snapshot, loading: true }; options.onChange(); }
    if (event.method === "Page.loadEventFired" || event.method === "Page.navigatedWithinDocument") {
      snapshot = { ...snapshot, loading: false };
      run(refresh());
    }
    if (event.method === "Runtime.exceptionThrown") {
      const details = event.params.exceptionDetails as { text?: string; exception?: { description?: string } };
      note(details.exception?.description ?? details.text ?? "Page exception");
    }
    if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error") {
      const args = event.params.args as Array<{ value?: unknown; description?: string }>;
      note(args.map((arg) => arg.description ?? String(arg.value)).join(" "));
    }
    if (event.method === "Network.loadingFailed") note(String(event.params.errorText));
  });
  try {
    await browser.send("Browser.getVersion");
    // Granting an empty set denies all other permission requests.
    await browser.send("Browser.grantPermissions", { permissions: [] });
    await browser.send("Browser.setDownloadBehavior", { behavior: "deny" });
    const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    pageTarget = targetId;
    const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    pageSession = sessionId;
    await send("Page.enable");
    await send("Page.setLifecycleEventsEnabled", { enabled: true });
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Fetch.enable", { patterns: [{ urlPattern: "file://*" }] });
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  } catch (error) { await browser.close(); throw error; }
  void browser.exited.then(() => {
    if (!destroyed) { snapshot = { ...snapshot, available: false, loading: false }; options.onChange(); }
  });

  const surface: PreviewSurface = {
    zoomFactor: () => 1,
    place(rect, _visible, device) {
      const nextWidth = Math.max(1, Math.round(device?.width ?? rect.width));
      const nextHeight = Math.max(1, Math.round(device?.height ?? rect.height));
      if (width === nextWidth && height === nextHeight && touch === (device?.touch ?? false) && dpr === (device?.dpr ?? 1)) return;
      touch = device?.touch ?? false;
      dpr = device?.dpr ?? 1;
      width = nextWidth; height = nextHeight;
      emulate();
    },
    async load(url, timeoutMs) {
      if (!(await previewFileAllowed(url, options.workspaceRoot()))) throw new Error("Preview cannot read a file outside the workspace.");
      await emulation;
      snapshot = { ...snapshot, loading: true, consoleErrors: [] };
      options.onChange();
      let release: () => void = () => undefined;
      let timer: NodeJS.Timeout | undefined;
      let wantedLoader: string | undefined;
      const loadedLoaders = new Set<string>();
      const loaded = new Promise<void>((resolve, reject) => {
        release = browser.onEvent((event) => {
          if (event.sessionId !== pageSession || event.method !== "Page.lifecycleEvent" || event.params.name !== "load") return;
          const loader = String(event.params.loaderId);
          loadedLoaders.add(loader);
          if (loader === wantedLoader) resolve();
        });
        timer = setTimeout(() => reject(new Error("Preview navigation timed out.")), timeoutMs);
      });
      // A rejected command must not leave a second, unhandled timer rejection.
      void loaded.catch(() => undefined);
      try {
        const result = await send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url });
        if (result.errorText) throw new Error(result.errorText);
        wantedLoader = result.loaderId;
        // Same-document navigation has no loader and no load event.
        if (wantedLoader && !loadedLoaders.has(wantedLoader)) await loaded;
        await refresh();
      } finally { clearTimeout(timer); release(); snapshot = { ...snapshot, loading: false }; options.onChange(); }
    },
    navigate(action) {
      if (action === "reload" || action === "hard-reload") run(send("Page.reload", { ignoreCache: action === "hard-reload" }));
      else run(send<{ entries: Array<{ id: number }>; currentIndex: number }>("Page.getNavigationHistory").then(async (history) => {
        const entry = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
        if (entry) await send("Page.navigateToHistoryEntry", { entryId: entry.id });
      }));
    },
    setZoom(factor) { if (zoom !== factor) { zoom = factor; emulate(); } },
    async setAppearance(appearance) {
      await send("Emulation.setEmulatedMedia", { features: appearance === "system" ? [] : [{ name: "prefers-color-scheme", value: appearance }] });
    },
    state: () => ({ ...snapshot, consoleErrors: [...snapshot.consoleErrors] }),
    viewport: () => ({ width: Math.round(width / zoom), height: Math.round(height / zoom) }),
    evaluate,
    async capture(maxWidth, rect, jpeg) {
      await emulation;
      const clip = rect ?? { x: 0, y: 0, ...surface.viewport() };
      const density = dpr * zoom;
      const scale = Math.min(1, maxWidth / (clip.width * density));
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: jpeg ? "jpeg" : "png", ...(jpeg ? { quality: 72 } : {}), clip: { ...clip, scale }, captureBeyondViewport: false });
      return { base64: data, width: Math.round(clip.width * scale * density), height: Math.round(clip.height * scale * density) };
    },
    async record() { throw new Error("Video recording requires a Tau desktop window. Screenshots and live Preview work without one."); },
    async pressKey(key) { await surface.input!({ kind: "key", key }); },
    async input(input) {
      await emulation;
      for (const [method, params] of cdpInputCommands(input, { touch })) await send(method, params);
    },
    async download(url, destination) {
      const workspace = options.workspaceRoot();
      if (!/^https?:$/u.test(new URL(url).protocol)) throw new Error("A download needs an http(s) URL.");
      const deadline = Date.now() + 20_000;
      const request = <T>(method: string, params: object) => browser.send<T>(method, params, pageSession, Math.max(1, deadline - Date.now()));
      const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
      const { resource } = await request<{ resource: { success: boolean; httpStatusCode?: number; stream?: string } }>("Network.loadNetworkResource", {
        frameId: frameTree.frame.id, url, options: { disableCache: false, includeCredentials: true },
      });
      if (!resource.success || !resource.stream || (resource.httpStatusCode !== undefined && (resource.httpStatusCode < 200 || resource.httpStatusCode >= 300))) {
        if (resource.stream) await browser.send("IO.close", { handle: resource.stream }, pageSession, 2_000).catch(() => undefined);
        throw new Error(`Download failed: ${resource.httpStatusCode ?? "network error"}.`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await request<{ data: string; base64Encoded?: boolean; eof: boolean }>("IO.read", { handle: resource.stream, size: 64 * 1024 });
          const bytes = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8");
          size += bytes.length;
          if (size > 50 * 1024 * 1024) throw new Error("Download exceeds 50 MB.");
          chunks.push(bytes);
          if (part.eof) break;
        }
      } finally { await browser.send("IO.close", { handle: resource.stream }, pageSession, 2_000).catch(() => undefined); }
      return savePreviewDownload(workspace, destination, Buffer.concat(chunks));
    },
    destroy() { destroyed = true; return closing ??= browser.close(); },
  };
  options.log("preview.headless.opened");
  return surface;
}
