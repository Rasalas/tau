import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ BrowserWindow: { getAllWindows: vi.fn(() => [] as unknown[]) } }));
vi.mock("electron", () => electron);

const { default: activate, screenshotWorkbench } = await import("./window.js");

function image(width: number, height: number, empty = false) {
  const made: Record<string, unknown> = {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from(`png-${width}x${height}`),
  };
  made.crop = vi.fn((box: { width: number; height: number }) => image(box.width, box.height));
  made.resize = vi.fn((size: { width: number; height: number }) => image(size.width, size.height));
  return made;
}

function fakeWindow(options: { minimized?: boolean; visible?: boolean; focused?: boolean; reading?: unknown; picture?: ReturnType<typeof image> } = {}) {
  const picture = options.picture ?? image(2400, 1600);
  const executeJavaScript = vi.fn(async (_script: string) => options.reading);
  const capturePage = vi.fn(async () => picture);
  return {
    window: {
      isDestroyed: () => false,
      isVisible: () => options.visible ?? true,
      isMinimized: () => options.minimized ?? false,
      isFocused: () => options.focused ?? false,
      webContents: { executeJavaScript, capturePage },
    },
    executeJavaScript,
    capturePage,
    picture,
  };
}
const asWindow = (fake: ReturnType<typeof fakeWindow>) => fake.window as never;

const reading = (boxes: Array<{ x: number; y: number; width: number; height: number }>) =>
  ({ viewport: { width: 1200, height: 800 }, parts: [{ part: "region:branch", boxes }] });

beforeEach(() => { electron.BrowserWindow.getAllWindows.mockReturnValue([]); });

describe("screenshotWorkbench", () => {
  it("answers no window when there is none, or it is minimized", async () => {
    expect(await screenshotWorkbench(undefined, {})).toMatchObject({ available: false, reason: expect.stringContaining("no open window") });
    const minimized = fakeWindow({ minimized: true });
    expect(await screenshotWorkbench(asWindow(minimized), {})).toMatchObject({ available: false, reason: expect.stringContaining("minimized") });
    expect(minimized.capturePage).not.toHaveBeenCalled();
  });

  it("takes the whole window, scaled down to the width limit", async () => {
    const fake = fakeWindow();
    const shot = await screenshotWorkbench(asWindow(fake), {});
    expect(shot).toMatchObject({ available: true, cropped: false, image: { width: 1600, height: 1067, mimeType: "image/png" } });
    expect(fake.executeJavaScript).not.toHaveBeenCalled();
  });

  it("crops to the regions of the named package, in the picture's pixels", async () => {
    const fake = fakeWindow({ reading: reading([{ x: 300, y: 20, width: 100, height: 30 }]) });
    const shot = await screenshotWorkbench(asWindow(fake), { extension: "local.copy-branch", margin: 10 });
    expect((fake.picture.crop as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({ x: 580, y: 20, width: 240, height: 100 });
    expect(shot).toMatchObject({ available: true, cropped: true, extension: { id: "local.copy-branch", found: true, parts: ["region:branch"] }, image: { width: 240, height: 100 } });
    expect(fake.executeJavaScript.mock.calls[0]![0]).toContain(JSON.stringify("local.copy-branch"));
  });

  it("gives the whole window when the package has nothing on screen", async () => {
    const fake = fakeWindow({ reading: { viewport: { width: 1200, height: 800 }, parts: [] } });
    const shot = await screenshotWorkbench(asWindow(fake), { extension: "local.gone" });
    expect(shot).toMatchObject({ available: true, cropped: false, extension: { id: "local.gone", found: false, parts: [] } });
    expect(fake.picture.crop).not.toHaveBeenCalled();
  });

  it("reports a picture that is empty", async () => {
    const fake = fakeWindow({ picture: image(0, 0, true) });
    expect(await screenshotWorkbench(asWindow(fake), {})).toMatchObject({ available: false, reason: expect.stringContaining("no picture") });
  });
});

describe("the window half", () => {
  it("looks only at this process's visible windows, the focused one first", async () => {
    const hidden = fakeWindow({ visible: false });
    const first = fakeWindow();
    const focused = fakeWindow({ focused: true });
    electron.BrowserWindow.getAllWindows.mockReturnValue([hidden.window, first.window, focused.window]);
    const half = activate({ id: "tau.packages", invokeHost: vi.fn(), log: vi.fn() });
    await half.handle("screenshot", {});
    expect(focused.capturePage).toHaveBeenCalledOnce();
    expect(first.capturePage).not.toHaveBeenCalled();
    expect(hidden.capturePage).not.toHaveBeenCalled();
  });

  it("has no window at all when every window is hidden", async () => {
    electron.BrowserWindow.getAllWindows.mockReturnValue([fakeWindow({ visible: false }).window]);
    const half = activate({ id: "tau.packages", invokeHost: vi.fn(), log: vi.fn() });
    expect(await half.handle("screenshot")).toMatchObject({ available: false });
  });

  it("refuses other commands", () => {
    const half = activate({ id: "tau.packages", invokeHost: vi.fn(), log: vi.fn() });
    expect(() => half.handle("capture-screen")).toThrow(/no command/u);
  });
});
