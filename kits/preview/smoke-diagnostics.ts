import type { App, BrowserWindow, RenderProcessGoneDetails, WebContents, WebContentsView } from "electron";
import type { PreviewPlacement } from "./view-placement.js";

const reasons = new Set(["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"]);
const reasonOf = (reason: string): string => reasons.has(reason) ? reason : "other";
const probe = <T>(read: () => T): T | "unavailable" => {
  try { return read(); } catch { return "unavailable"; }
};

async function sample<T>(read: () => Promise<T>, timeoutMs: number): Promise<{ status: "ok"; value: T } | { status: "error" | "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then((value) => ({ status: "ok" as const, value }), () => ({ status: "error" as const })),
      new Promise<{ status: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts before the first preview opens, so an early GPU exit is retained. */
export function observePreviewSmokeProcesses(app: App) {
  const since = Date.now();
  const gone: Array<{ type: string; reason: string; exitCode: number; webContentsId?: number }> = [];
  const processGone = (_event: unknown, details: Electron.Details) => {
    const type = ["GPU", "Utility", "Zygote", "Sandbox helper"].includes(details.type) ? details.type : "other";
    gone.push({ type, reason: reasonOf(details.reason), exitCode: details.exitCode });
    if (gone.length > 10) gone.shift();
  };
  const renderGone = (_event: unknown, contents: WebContents, details: RenderProcessGoneDetails) => {
    gone.push({ type: "Renderer", reason: reasonOf(details.reason), exitCode: details.exitCode, webContentsId: contents.id });
    if (gone.length > 10) gone.shift();
  };
  app.on("child-process-gone", processGone);
  app.on("render-process-gone", renderGone);
  return {
    read: () => ({ since, gone: [...gone] }),
    dispose() { app.off("child-process-gone", processGone); app.off("render-process-gone", renderGone); },
  };
}

/** Smoke-only counters and probes. No URLs, page text, image bytes or raw errors leave this module. */
export function observePreviewSmoke(contents: WebContents, view: WebContentsView, window: BrowserWindow, placement: PreviewPlacement, app: App, processes?: ReturnType<typeof observePreviewSmokeProcesses>) {
  const since = Date.now();
  const processHistory = processes ?? observePreviewSmokeProcesses(app);
  const counts = { paint: 0, domReady: 0, didFinishLoad: 0, didFailLoad: 0 };
  const rendererGone: Array<{ reason: string; exitCode: number }> = [];
  const paint = () => { counts.paint += 1; };
  const domReady = () => { counts.domReady += 1; };
  const loaded = () => { counts.didFinishLoad += 1; };
  const failed = () => { counts.didFailLoad += 1; };
  const renderGone = (_event: unknown, details: RenderProcessGoneDetails) => {
    rendererGone.push({ reason: reasonOf(details.reason), exitCode: details.exitCode });
    if (rendererGone.length > 10) rendererGone.shift();
  };
  contents.on("paint", paint);
  contents.on("dom-ready", domReady);
  contents.on("did-finish-load", loaded);
  contents.on("did-fail-load", failed);
  contents.on("render-process-gone", renderGone);

  return {
    async read(capturePage: boolean) {
      const facts = {
        available: true,
        sampledAt: Date.now(),
        observingSince: since,
        contents: {
          id: contents.id,
          destroyed: contents.isDestroyed(),
          loading: probe(() => contents.isLoading()),
          offscreen: probe(() => contents.isOffscreen()),
          painting: probe(() => contents.isPainting()),
          backgroundThrottling: probe(() => contents.getBackgroundThrottling()),
          rendererPid: probe(() => contents.getOSProcessId()),
        },
        window: {
          destroyed: window.isDestroyed(),
          visible: probe(() => window.isVisible()),
          minimized: probe(() => window.isMinimized()),
        },
        view: { visible: probe(() => view.getVisible()), bounds: probe(() => view.getBounds()), onScreen: placement.onScreen() },
        stage: probe(() => placement.diagnostics()),
        counts: { ...counts },
        rendererGone: [...rendererGone],
        processes: processHistory.read(),
      };
      const document = await sample(async () => {
        const value = await contents.executeJavaScriptInIsolatedWorld(1_022, [{ code: "({ visibility: document.visibilityState, ready: document.readyState, width: innerWidth, height: innerHeight })" }]) as Record<string, unknown>;
        return {
          visibility: value.visibility === "visible" || value.visibility === "hidden" ? value.visibility : "other",
          ready: ["loading", "interactive", "complete"].includes(String(value.ready)) ? value.ready as string : "other",
          width: typeof value.width === "number" && Number.isFinite(value.width) ? value.width : null,
          height: typeof value.height === "number" && Number.isFinite(value.height) ? value.height : null,
        };
      }, 1_000);
      const capture = capturePage ? await sample(async () => {
        const image = await contents.capturePage();
        const { width, height } = image.getSize();
        return { empty: image.isEmpty(), width, height };
      }, 2_000) : { status: "not-requested" };
      return { ...facts, document, capturePage: capture };
    },
    dispose() {
      contents.off("paint", paint);
      contents.off("dom-ready", domReady);
      contents.off("did-finish-load", loaded);
      contents.off("did-fail-load", failed);
      contents.off("render-process-gone", renderGone);
      if (!processes) processHistory.dispose();
    },
  };
}
