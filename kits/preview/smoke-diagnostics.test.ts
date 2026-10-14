import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observePreviewSmoke, observePreviewSmokeProcesses } from "./smoke-diagnostics.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    isLoading: () => false,
    isOffscreen: () => false,
    isPainting: () => false,
    getBackgroundThrottling: () => true,
    getOSProcessId: () => 42,
    executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ visibility: "hidden", ready: "complete", width: 1280, height: 800, url: "secret" })),
    capturePage: vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), bytes: "secret" })),
  });
  const view = { getVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }) };
  const window = { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false };
  const placement = { onScreen: () => false, diagnostics: () => ({ visible: false, minimized: false, bounds: view.getBounds() }) };
  const app = new EventEmitter();
  const diagnostic = observePreviewSmoke(
    contents as unknown as Parameters<typeof observePreviewSmoke>[0],
    view as Parameters<typeof observePreviewSmoke>[1],
    window as Parameters<typeof observePreviewSmoke>[2],
    placement as Parameters<typeof observePreviewSmoke>[3],
    app as Parameters<typeof observePreviewSmoke>[4],
  );
  return { contents, view, app, diagnostic };
}

describe("preview smoke diagnostics", () => {
  it("retains GPU exits before the preview is created and caps the process history", () => {
    const app = new EventEmitter();
    const history = observePreviewSmokeProcesses(app as Parameters<typeof observePreviewSmokeProcesses>[0]);
    for (let exitCode = 0; exitCode < 12; exitCode += 1) app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode, name: "secret" });
    expect(history.read().gone).toHaveLength(10);
    expect(history.read().gone[0]).toEqual({ type: "GPU", reason: "crashed", exitCode: 2 });
    app.emit("render-process-gone", {}, { id: 7, url: "secret" }, { reason: "oom", exitCode: 9 });
    expect(history.read().gone.at(-1)).toEqual({ type: "Renderer", reason: "oom", exitCode: 9, webContentsId: 7 });
    expect(JSON.stringify(history.read())).not.toContain("secret");
    history.dispose();
    expect(app.eventNames()).toEqual([]);
  });

  it("reports geometry, visibility, counters and process failures without page contents", async () => {
    const { contents, app, diagnostic } = fixture();
    contents.emit("paint", {}, {}, { bytes: "secret" });
    contents.emit("dom-ready");
    contents.emit("did-finish-load");
    contents.emit("did-fail-load", {}, -1, "secret", "secret");
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11, url: "secret" });
    app.emit("child-process-gone", {}, { type: "GPU", reason: "killed", exitCode: 9, name: "secret", serviceName: "secret" });
    const facts = await diagnostic.read(false);
    expect(facts).toMatchObject({
      contents: { offscreen: false, painting: false, loading: false, backgroundThrottling: true, rendererPid: 42 },
      window: { visible: false, minimized: false },
      view: { visible: true, onScreen: false, bounds: { width: 1280, height: 800 } },
      stage: { visible: false },
      document: { status: "ok", value: { visibility: "hidden", ready: "complete", width: 1280, height: 800 } },
      counts: { paint: 1, domReady: 1, didFinishLoad: 1, didFailLoad: 1 },
      rendererGone: [{ reason: "crashed", exitCode: 11 }],
      processes: { gone: [{ type: "GPU", reason: "killed", exitCode: 9 }] },
      capturePage: { status: "not-requested" },
    });
    expect(JSON.stringify(facts)).not.toContain("secret");
    expect(contents.capturePage).not.toHaveBeenCalled();
    expect((await diagnostic.read(true)).capturePage).toEqual({ status: "ok", value: { empty: false, width: 1280, height: 800 } });
    diagnostic.dispose();
    expect(contents.eventNames()).toEqual([]);
    expect(app.eventNames()).toEqual([]);
  });

  it("bounds hung document and capture probes and retains status when the renderer is gone", async () => {
    vi.useFakeTimers();
    const { contents, diagnostic } = fixture();
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(() => new Promise(() => undefined));
    contents.capturePage.mockImplementation(() => new Promise(() => undefined));
    const answer = diagnostic.read(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await answer).toMatchObject({ document: { status: "timeout" }, capturePage: { status: "timeout" } });
    contents.isDestroyed = () => true;
    contents.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error("secret"));
    contents.capturePage.mockRejectedValue(new Error("secret"));
    const gone = await diagnostic.read(true);
    expect(gone).toMatchObject({ contents: { destroyed: true }, document: { status: "error" }, capturePage: { status: "error" } });
    expect(JSON.stringify(gone)).not.toContain("secret");
    diagnostic.dispose();
  });
});
