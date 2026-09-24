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
}));
vi.mock("electron", async () => {
  const { fakeView } = await import("./fake-electron-window.js");
  return {
    WebContentsView: class {
      constructor() {
        return Object.assign(fakeView(), { webContents: electron.contents });
      }
    },
    BaseWindow: class {},
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

const { createElectronPreviewSurface, cropToView } = await import("./view.js");

const surface = () => createElectronPreviewSurface({ partition: "", onChange: () => undefined, workspaceRoot: () => "", log: () => undefined })!;

beforeEach(() => {
  let attached = false;
  electron.window = fakeWindow();
  electron.contents = {
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: () => false,
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
