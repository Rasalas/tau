import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  BrowserWindow: { getAllWindows: vi.fn(() => [] as unknown[]) },
  // The test's "PNG" is the size it should decode to: "WxH".
  nativeImage: { createFromBuffer: vi.fn((buffer: Buffer) => { const [, w, h] = /(\d+)x(\d+)/u.exec(buffer.toString())!; return image(Number(w), Number(h)); }) },
}));
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

/** The debugger session of a window; `attached` is whether someone else holds it already. */
function fakeDebugger(rendered: { width: number; height: number }, attached = false) {
  let held = attached;
  return {
    isAttached: vi.fn(() => held),
    attach: vi.fn(() => { held = true; }),
    detach: vi.fn(() => { held = false; }),
    sendCommand: vi.fn(async () => ({ data: Buffer.from(`png-${rendered.width}x${rendered.height}`).toString("base64") })),
  };
}

function fakeWindow(options: { minimized?: boolean; visible?: boolean; focused?: boolean; reading?: unknown; picture?: ReturnType<typeof image>; debugger?: ReturnType<typeof fakeDebugger> } = {}) {
  const picture = options.picture ?? image(2400, 1600);
  const executeJavaScript = vi.fn(async (_script: string) => options.reading);
  const capturePage = vi.fn(async () => picture);
  return {
    window: {
      isDestroyed: () => false,
      isVisible: () => options.visible ?? true,
      isMinimized: () => options.minimized ?? false,
      isFocused: () => options.focused ?? false,
      webContents: { executeJavaScript, capturePage, ...(options.debugger ? { debugger: options.debugger } : {}) },
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
    // It still waits for the page to paint, so the picture is not older than the page.
    expect(fake.executeJavaScript.mock.calls.map(([script]) => script)).toEqual([expect.stringContaining("requestAnimationFrame")]);
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
    const shot = await screenshotWorkbench(asWindow(fake), { extension: "local.gone" }, 0);
    expect(shot).toMatchObject({ available: true, cropped: false, extension: { id: "local.gone", found: false, parts: [] } });
    expect(fake.picture.crop).not.toHaveBeenCalled();
  });

  it("reads the page after a paint and takes the picture right after the last reading", async () => {
    const fake = fakeWindow({ reading: reading([{ x: 300, y: 20, width: 100, height: 30 }]) });
    const calls: string[] = [];
    fake.executeJavaScript.mockImplementation(async (script: string) => { calls.push(script.includes("requestAnimationFrame") ? "read-after-paint" : "read"); return reading([{ x: 300, y: 20, width: 100, height: 30 }]); });
    fake.capturePage.mockImplementation(async () => { calls.push("capture"); return fake.picture; });
    await screenshotWorkbench(asWindow(fake), { extension: "local.copy-branch" });
    expect(calls).toEqual(["read-after-paint", "capture"]);
  });

  it("looks again for a package that has not drawn its parts yet, so a fresh install is not cropped away", async () => {
    const fake = fakeWindow();
    const shown = reading([{ x: 300, y: 700, width: 100, height: 12 }]);
    fake.executeJavaScript
      .mockResolvedValueOnce({ viewport: { width: 1200, height: 800 }, parts: [] })
      .mockResolvedValueOnce({ viewport: { width: 1200, height: 800 }, parts: [] })
      .mockResolvedValue(shown);
    const shot = await screenshotWorkbench(asWindow(fake), { extension: "local.status", margin: 10 }, 5_000);
    expect(fake.executeJavaScript).toHaveBeenCalledTimes(3);
    expect(shot).toMatchObject({ available: true, cropped: true, extension: { found: true } });
  });

  it("gives up after the patience and answers with the whole window", async () => {
    const fake = fakeWindow({ reading: { viewport: { width: 1200, height: 800 }, parts: [] } });
    const shot = await screenshotWorkbench(asWindow(fake), { extension: "local.gone" }, 200);
    expect(fake.executeJavaScript.mock.calls.length).toBeGreaterThan(1);
    expect(shot).toMatchObject({ available: true, cropped: false, extension: { found: false } });
  });

  it("renders the crop afresh at the page's pixel ratio instead of trusting the window's last frame", async () => {
    const session = fakeDebugger({ width: 240, height: 100 });
    const fake = fakeWindow({ debugger: session, reading: { ...reading([{ x: 300, y: 20, width: 100, height: 30 }]), pixelRatio: 2 } });
    const shot = await screenshotWorkbench(asWindow(fake), { extension: "local.copy-branch", margin: 10 });
    expect(session.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: 290, y: 10, width: 120, height: 50, scale: 2 } });
    expect(fake.capturePage).not.toHaveBeenCalled();
    expect(shot).toMatchObject({ available: true, cropped: true, image: { width: 240, height: 100 } });
  });

  it("renders the whole window without a clip, and detaches only a session it attached itself", async () => {
    const own = fakeDebugger({ width: 2400, height: 1600 });
    expect(await screenshotWorkbench(asWindow(fakeWindow({ debugger: own })), {})).toMatchObject({ available: true, cropped: false });
    expect(own.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", fromSurface: true });
    expect(own.attach).toHaveBeenCalledOnce();
    expect(own.detach).toHaveBeenCalledOnce();

    const shared = fakeDebugger({ width: 2400, height: 1600 }, true);
    await screenshotWorkbench(asWindow(fakeWindow({ debugger: shared })), {});
    expect(shared.attach).not.toHaveBeenCalled();
    expect(shared.detach).not.toHaveBeenCalled();
  });

  it("falls back to the window's own capture when the debugger cannot render", async () => {
    const session = fakeDebugger({ width: 1, height: 1 });
    session.sendCommand.mockRejectedValue(new Error("Another debugger is attached"));
    const fake = fakeWindow({ debugger: session });
    expect(await screenshotWorkbench(asWindow(fake), {})).toMatchObject({ available: true, image: { width: 1600 } });
    expect(fake.capturePage).toHaveBeenCalledOnce();
    expect(session.detach).toHaveBeenCalledOnce();
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
