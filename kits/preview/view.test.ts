import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWindow, type FakeWindow } from "./fake-electron-window.js";
import { createRemotePreviewSurface } from "./remote-surface.js";

interface FakeImage {
  size: { width: number; height: number };
  getSize(): { width: number; height: number };
  crop(rect: { x: number; y: number; width: number; height: number }): FakeImage;
  resize(options: { width: number; height: number }): FakeImage;
  toJPEG(): Buffer;
  toPNG(): Buffer;
}

const fakeImage = (width: number, height: number, tag: string): FakeImage => ({
  size: { width, height },
  getSize() { return { width, height }; },
  crop: (rect) => fakeImage(rect.width, rect.height, `${tag}:crop`),
  resize: (options) => fakeImage(options.width, options.height, tag),
  toJPEG: () => Buffer.from(`${tag}:jpeg`),
  toPNG: () => Buffer.from(`${tag}:png`),
});

const electron = vi.hoisted(() => ({
  window: undefined as unknown as FakeWindow,
  contents: undefined as unknown as {
    capturePage: ReturnType<typeof vi.fn>;
    setBackgroundThrottling: ReturnType<typeof vi.fn>;
    debugger: { isAttached(): boolean; attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };
  } & Record<string, unknown>,
  createFromBuffer: vi.fn(),
  webPreferences: {} as { backgroundThrottling?: boolean },
  backgroundThrottling: true,
  recorder: { start: vi.fn(), take: vi.fn(), stop: vi.fn(), dispose: vi.fn() },
  stages: [] as FakeWindow[],
  clipboardText: vi.fn(),
  clipboardWrite: vi.fn(async () => undefined),
  openExternal: vi.fn(),
}));
vi.mock("electron", async () => {
  const { fakeView, fakeWindow: stageWindow } = await import("./fake-electron-window.js");
  return {
    WebContentsView: class {
      constructor(options: { webPreferences: { backgroundThrottling?: boolean } }) {
        electron.webPreferences = options.webPreferences;
        electron.backgroundThrottling = options.webPreferences.backgroundThrottling !== false;
        return Object.assign(fakeView(), { webContents: electron.contents });
      }
    },
    BaseWindow: class {
      constructor() {
        const stage = stageWindow();
        stage.visible = false;
        electron.stages.push(stage);
        return stage;
      }
    },
    BrowserWindow: { getFocusedWindow: () => electron.window, getAllWindows: () => [electron.window] },
    nativeImage: { createFromBuffer: electron.createFromBuffer },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      }),
    },
    shell: { openExternal: electron.openExternal },
    clipboard: { writeText: electron.clipboardText, write: electron.clipboardWrite },
    ClipboardItem: class { constructor(public items: unknown) {} },
  };
});

vi.mock("./recorder.js", () => ({ PreviewRecorder: class { constructor() { return electron.recorder; } } }));

const { default: activatePreviewWindowHalf, createElectronPreviewSurface, cropToView, deviceOverride } = await import("./view.js");

const surface = () => createElectronPreviewSurface({ partition: "", onChange: () => undefined, workspaceRoot: () => "", log: () => undefined })!;

beforeEach(() => {
  let attached = false;
  electron.stages.length = 0;
  electron.window = fakeWindow();
  electron.openExternal.mockClear();
  electron.clipboardText.mockClear();
  electron.recorder.start.mockReset().mockResolvedValue({ chunks: [], mimeType: "video/webm" });
  electron.recorder.stop.mockReset().mockResolvedValue({ chunks: [], mimeType: "video/webm" });
  electron.contents = {
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    getURL: () => "",
    getTitle: () => "",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    close: vi.fn(),
    setBackgroundThrottling: vi.fn((allowed: boolean) => { electron.backgroundThrottling = allowed; }),
    // What Electron does for a view that never reached the screen.
    capturePage: vi.fn(async () => { throw new Error("Current display surface not available for capture"); }),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true; }),
      detach: vi.fn(() => { attached = false; }),
      sendCommand: vi.fn(async () => ({ data: Buffer.from("shot").toString("base64") })),
    },
  };
  electron.createFromBuffer.mockImplementation(() => fakeImage(2_560, 1_600, "cdp"));
});

describe("a preview call without a drawable window", () => {
  it("passes observation demand through the kit's window half", async () => {
    const half = activatePreviewWindowHalf({ id: "tau.preview", invokeHost: vi.fn(), log: vi.fn() });
    const remote = createRemotePreviewSurface({ partition: "", onChange: vi.fn(), workspaceRoot: () => "", log: vi.fn() }, async (command, input) => half.handle(command, input));
    await remote.open();
    remote.setObserved!(true);
    await vi.waitFor(() => expect(electron.backgroundThrottling).toBe(false));
    remote.setObserved!(false);
    await vi.waitFor(() => expect(electron.backgroundThrottling).toBe(true));
    half.dispose?.();
  });

  it("explains how to enable a host-rendered preview instead of retrying another client's window", () => {
    electron.window = undefined as unknown as FakeWindow;
    const half = activatePreviewWindowHalf({ id: "tau.preview", invokeHost: vi.fn(), log: vi.fn() });
    expect(() => half.handle("open-view")).toThrow(/Open the Tau desktop app on the thread's home machine.*Preview.*phone or browser/u);
    expect(electron.stages).toHaveLength(0);
  });

  it("rebuilds the closed window's surface on the next request instead of reusing a destroyed view", () => {
    const half = activatePreviewWindowHalf({ id: "tau.preview", invokeHost: vi.fn(), log: vi.fn() });
    half.handle("open-view");
    const first = electron.window;
    first.destroy();
    first.emit("closed");
    electron.window = undefined as unknown as FakeWindow;
    expect(() => half.handle("open-view")).toThrow(/Open the Tau desktop app/u);
    electron.window = fakeWindow();
    half.handle("open-view");
    expect(electron.window.contentView.children).toHaveLength(1);
    half.dispose?.();
  });
});

describe("the preview surface's capture", () => {
  it("draws a view the window never showed, without showing it", async () => {
    const view = surface();
    view.place({ x: 0, y: 0, width: 1_280, height: 800 }, false);

    const shot = await view.capture(393, undefined, true);

    expect(electron.contents.capturePage).not.toHaveBeenCalled();
    expect(electron.contents.debugger.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    expect(shot).toEqual({ base64: Buffer.from("cdp:jpeg").toString("base64"), width: 393, height: 246 });
  });

  it("takes the compositor's frame while the view is on screen, and not once the window is minimized", async () => {
    electron.contents.capturePage.mockResolvedValue(fakeImage(2_560, 1_600, "frame"));
    const view = surface();
    view.place({ x: 10, y: 40, width: 1_280, height: 800 }, true);

    expect((await view.capture(1_600)).base64).toBe(Buffer.from("frame:png").toString("base64"));
    electron.window.minimized = true;
    expect((await view.capture(1_600)).base64).toBe(Buffer.from("cdp:png").toString("base64"));
    expect(electron.contents.capturePage).toHaveBeenCalledTimes(1);
  });
});

describe("a hidden view's screenshot", () => {
  it("leaves an unused hidden preview throttled", () => {
    const view = surface();
    view.place({ x: 0, y: 0, width: 800, height: 600 }, false);
    expect(electron.backgroundThrottling).toBe(true);
    view.destroy();
  });

  it("keeps overlapping captures awake until the last one finishes", async () => {
    const finish: Array<(value: { data: string }) => void> = [];
    electron.contents.debugger.sendCommand.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    const view = surface();
    const first = view.capture(640);
    const second = view.capture(640);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    expect(electron.backgroundThrottling).toBe(false);
    finish[0]!({ data: "c2hvdA==" });
    await first;
    expect(electron.backgroundThrottling).toBe(false);
    finish[1]!({ data: "c2hvdA==" });
    await second;
    expect(electron.backgroundThrottling).toBe(true);
    view.destroy();
  });

  it("restores throttling after a capture times out", async () => {
    vi.useFakeTimers();
    const view = surface();
    try {
      electron.contents.debugger.sendCommand.mockImplementation(() => new Promise(() => undefined));
      const answer = view.capture(640).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await answer).toEqual(new Error("The hidden page did not paint."));
      expect(electron.backgroundThrottling).toBe(true);
    } finally {
      view.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps an observed hidden page awake and follows window visibility", () => {
    const view = surface();
    view.place({ x: 0, y: 0, width: 800, height: 600 }, true);
    view.setObserved!(true);
    expect(electron.backgroundThrottling).toBe(true);
    electron.window.minimized = true;
    electron.window.emit("minimize");
    expect(electron.backgroundThrottling).toBe(false);
    view.setObserved!(false);
    expect(electron.backgroundThrottling).toBe(true);
    view.destroy();
  });

  it("keeps frames running for a recording, then restores throttling on stop or start failure", async () => {
    const view = surface();
    await view.record("start");
    expect(electron.backgroundThrottling).toBe(false);
    await view.capture(640);
    expect(electron.backgroundThrottling).toBe(false);
    await view.record("stop");
    expect(electron.backgroundThrottling).toBe(true);
    electron.recorder.start.mockRejectedValueOnce(new Error("recorder refused"));
    await expect(view.record("start")).rejects.toThrow("recorder refused");
    expect(electron.backgroundThrottling).toBe(true);
    view.destroy();
  });

  it.each([true, false])("keeps producing frames while its parent window is visible=%s", async (visible) => {
    vi.useFakeTimers();
    let view: ReturnType<typeof surface> | undefined;
    try {
      electron.window.visible = visible;
      // Model Chromium withholding hidden frames while background throttling is enabled.
      electron.contents.debugger.sendCommand.mockImplementation(async () => {
        if (electron.backgroundThrottling) return new Promise(() => undefined);
        return { data: Buffer.from("shot").toString("base64") };
      });
      view = surface();
      view.place({ x: 0, y: 0, width: 1_280, height: 800 }, false);
      const answer = view.capture(640, undefined, true).then((shot) => ({ shot }), (error: unknown) => ({ error }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await answer).toMatchObject({ shot: { width: 640, height: 400 } });
      expect(electron.backgroundThrottling).toBe(true);
      expect(electron.contents.capturePage).not.toHaveBeenCalled();
      expect(electron.window.visible).toBe(visible);
      expect(electron.window.contentView.children.every((child) => !child.visible)).toBe(true);
      expect(electron.stages.every((stage) => !stage.visible)).toBe(true);
    } finally {
      view?.destroy();
      vi.useRealTimers();
    }
  });

  it("asks again when the first request hangs, as a view hidden in a painting window needs", async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      electron.contents.debugger.sendCommand.mockImplementation(async (method: string) => {
        if (method !== "Page.captureScreenshot") return {};
        asked += 1;
        return asked === 1 ? new Promise(() => undefined) : { data: Buffer.from("shot").toString("base64") };
      });
      const view = surface();
      view.place({ x: 0, y: 0, width: 1_280, height: 800 }, false);
      const shot = view.capture(640, undefined, true);
      await vi.advanceTimersByTimeAsync(500);
      await expect(shot).resolves.toMatchObject({ width: 640 });
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a device's layout", () => {
  const phone = { width: 390, height: 600, dpr: 3, touch: true };
  const commands = () => electron.contents.debugger.sendCommand.mock.calls.map(([method]) => method as string);

  it("emulates the device's screen and takes its pictures at the device's size", async () => {
    electron.contents.capturePage.mockResolvedValue(fakeImage(786, 1_400, "frame"));
    electron.createFromBuffer.mockImplementation(() => fakeImage(1_170, 1_800, "cdp"));
    const view = surface();
    view.place({ x: 0, y: 0, width: 393, height: 700 }, true, phone);

    expect(view.viewport()).toEqual({ width: 390, height: 600 });
    const shot = await view.capture(780, undefined, true);
    expect(commands().slice(0, 2)).toEqual(["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled"]);
    expect(electron.contents.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", expect.objectContaining({ width: 390, height: 600, deviceScaleFactor: 3, mobile: true }));
    expect(electron.contents.capturePage).not.toHaveBeenCalled();
    expect(shot).toMatchObject({ width: 780, height: 1_200 });
  });

  it("paints the page in the stage while the window does not show it, and back in the window when it does", async () => {
    const view = surface();
    view.place({ x: 0, y: 0, width: 393, height: 700 }, false, phone);
    expect(electron.stages).toHaveLength(1);
    expect(electron.window.contentView.children).toHaveLength(0);
    view.place({ x: 0, y: 0, width: 393, height: 700 }, true);
    await vi.waitFor(() => expect(electron.window.contentView.children[0]?.visible).toBe(true));
    expect(electron.stages[0]?.destroyed).toBe(true);
  });

  it("taps with touches on a touch screen", async () => {
    const view = surface();
    view.place({ x: 0, y: 0, width: 393, height: 700 }, false, phone);
    await view.input!({ kind: "click", x: 20, y: 30 });
    expect(commands()).toContain("Input.dispatchTouchEvent");
    expect(commands()).not.toContain("Input.dispatchMouseEvent");
  });

  it("shows the view again only once the page has its own layout back", async () => {
    let clear: (() => void) | undefined;
    electron.contents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Emulation.clearDeviceMetricsOverride") await new Promise<void>((resolve) => { clear = resolve; });
      return { data: "" };
    });
    const view = surface();
    view.place({ x: 0, y: 0, width: 393, height: 700 }, false, phone);
    await view.capture(100).catch(() => undefined);
    view.place({ x: 0, y: 0, width: 393, height: 700 }, true);
    const shown = () => electron.window.contentView.children[0]?.visible === true;
    expect(shown()).toBe(false);
    await vi.waitFor(() => expect(clear).toBeDefined());
    clear!();
    await vi.waitFor(() => expect(shown()).toBe(true));
    expect(view.viewport()).toEqual({ width: 393, height: 700 });
  });

  it("emulates a phone's browser for a touch screen only", () => {
    expect(deviceOverride({ width: 390, height: 844, dpr: 3, touch: true })).toMatchObject({ width: 390, deviceScaleFactor: 3, mobile: true });
    expect(deviceOverride({ width: 1_280, height: 800, dpr: 1, touch: false })).toMatchObject({ mobile: false });
  });

  it("never draws a device's layout in the window, even while the panel shows", () => {
    const view = surface();
    view.place({ x: 0, y: 0, width: 393, height: 700 }, true, phone);
    expect(electron.window.contentView.children).toHaveLength(0);
    expect(electron.stages).toHaveLength(1);
  });
});

describe("preview input delivery", () => {
  it("reports a rejected input and still accepts the next operation", async () => {
    let refused = false;
    electron.contents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Input.dispatchKeyEvent" && !refused) {
        refused = true;
        throw new Error("fixture refused key");
      }
      return {};
    });
    const view = surface();
    await expect(view.pressKey("Enter")).rejects.toThrow("fixture refused key");
    await expect(view.input!({ kind: "text", text: "next" })).resolves.toBeUndefined();
  });
});

describe("the page's right-click menu", () => {
  const params = (over: Record<string, unknown> = {}) => ({
    x: 30, y: 40, linkURL: "", srcURL: "", mediaType: "none", selectionText: "", isEditable: false,
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true }, frame: undefined, ...over,
  });
  function open(choose: string | undefined) {
    const showContextMenu = vi.fn(async (_entries: unknown[], _point: { x: number; y: number }) => choose);
    const view = createElectronPreviewSurface({ partition: "", onChange: () => undefined, workspaceRoot: () => "", log: () => undefined, showContextMenu })!;
    view.place({ x: 100, y: 60, width: 800, height: 600 }, true);
    const registered = ((electron.contents.on as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>).filter(([name]) => name === "context-menu");
    const handler = registered.at(-1)![1] as (event: unknown, params: unknown) => void;
    return { showContextMenu, ask: (over?: Record<string, unknown>) => handler({}, params(over)) };
  }

  it("shows the window's native menu at the click, offset by where the view sits", async () => {
    const { showContextMenu, ask } = open(undefined);
    ask({ linkURL: "https://example.com" });
    await vi.waitFor(() => expect(showContextMenu).toHaveBeenCalled());
    expect(showContextMenu.mock.calls[0]![1]).toEqual({ x: 130, y: 100 });
  });

  it("shows nothing on plain page, and without a menu to lend", () => {
    const { showContextMenu, ask } = open(undefined);
    ask();
    expect(showContextMenu).not.toHaveBeenCalled();
    const bare = createElectronPreviewSurface({ partition: "", onChange: () => undefined, workspaceRoot: () => "", log: () => undefined })!;
    expect(bare).toBeDefined();
  });

  it("opens a web link in the browser and copies its address", async () => {
    open("open-link").ask({ linkURL: "https://example.com/a" });
    await vi.waitFor(() => expect(electron.openExternal).toHaveBeenCalledWith("https://example.com/a"));
    open("copy-link").ask({ linkURL: "https://example.com/b" });
    await vi.waitFor(() => expect(electron.clipboardText).toHaveBeenCalledWith("https://example.com/b"));
  });

  it("never opens a link that is not a web link, even if asked", async () => {
    open("open-link").ask({ linkURL: "file:///etc/passwd" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(electron.openExternal).not.toHaveBeenCalled();
  });

  it("copies an image of the page's own frame where it was clicked", async () => {
    const copyImageAt = vi.fn();
    Object.assign(electron.contents, { copyImageAt, mainFrame: "main" });
    open("copy-image").ask({ mediaType: "image", srcURL: "https://example.com/a.png", frame: "main" });
    await vi.waitFor(() => expect(copyImageAt).toHaveBeenCalledWith(30, 40));
  });
});

describe("cropToView", () => {
  it("cuts the view's rectangle out of an image at the view's pixel density", () => {
    const image = fakeImage(2_560, 1_600, "full");
    const crop = vi.spyOn(image, "crop");

    cropToView(image as never, 1_280, { x: 100, y: 50, width: 200, height: 100 });
    expect(crop).toHaveBeenCalledWith({ x: 200, y: 100, width: 400, height: 200 });

    cropToView(image as never, 1_280, { x: 1_200, y: 790, width: 200, height: 100 });
    expect(crop).toHaveBeenLastCalledWith({ x: 2_400, y: 1_580, width: 160, height: 20 });
    expect(cropToView(image as never, 1_280)).toBe(image);
  });
});
