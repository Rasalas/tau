import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWindow, type FakeWindow } from "./fake-electron-window.js";

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
    debugger: { isAttached(): boolean; attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };
  } & Record<string, unknown>,
  createFromBuffer: vi.fn(),
  stages: [] as FakeWindow[],
}));
vi.mock("electron", async () => {
  const { fakeView, fakeWindow: stageWindow } = await import("./fake-electron-window.js");
  return {
    WebContentsView: class {
      constructor() {
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
    shell: { openExternal: vi.fn() },
  };
});

const { createElectronPreviewSurface, cropToView, deviceOverride } = await import("./view.js");

const surface = () => createElectronPreviewSurface({ partition: "", onChange: () => undefined, workspaceRoot: () => "", log: () => undefined })!;

beforeEach(() => {
  let attached = false;
  electron.stages.length = 0;
  electron.window = fakeWindow();
  electron.contents = {
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    // What Electron does for a view that never reached the screen.
    capturePage: vi.fn(async () => { throw new Error("Current display surface not available for capture"); }),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true; }),
      sendCommand: vi.fn(async () => ({ data: Buffer.from("shot").toString("base64") })),
    },
  };
  electron.createFromBuffer.mockImplementation(() => fakeImage(2_560, 1_600, "cdp"));
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
