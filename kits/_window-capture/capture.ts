import { WebContentsView, session, type DesktopCapturerSource } from "electron";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Records one window, named by its id, in a hidden page. Computer Use's live
 * view and SnapShots share it; a screen can never be named here.
 */

/** A frame drawn from the recording: an image data URL, scaled down. */
export interface WindowFrame {
  seq: number;
  url: string;
  width: number;
  height: number;
}

export interface WindowCaptureOptions {
  /** In-memory partition of the capture page; each caller keeps its own, since the request handler is the partition's. */
  partition: string;
  maxWidth: number;
  mimeType: "image/jpeg" | "image/png";
  /** JPEG quality, 0–1. */
  quality?: number;
  frameRate?: number;
}

/** The desktop-capture id of one window. There is deliberately no way to name a screen. */
export function windowSourceId(windowId: unknown): string {
  if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId <= 0) throw new Error("A capture records one window, named by its id.");
  return `window:${windowId}:0`;
}

let capturePage: Promise<string> | undefined;
// `getDisplayMedia` needs a secure context, which `about:blank` is not; a file is.
const pageFile = (): Promise<string> => capturePage ??= (async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-window-capture-"));
  const file = join(directory, "capture.html");
  await writeFile(file, "<!doctype html><meta charset=\"utf-8\"><title>Tau window capture</title>");
  return file;
})();

const startScript = (frameRate: number): string => `(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: ${frameRate} }, audio: false });
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  const state = { seq: 0, ended: false, stream, video, canvas: document.createElement("canvas") };
  stream.getVideoTracks()[0]?.addEventListener("ended", () => { state.ended = true; });
  globalThis.__tauCapture = state;
  return true;
})()`;

// Drawn when asked, so a caller that stops asking costs nothing.
const takeScript = (options: WindowCaptureOptions): string => `(() => {
  const state = globalThis.__tauCapture;
  if (!state) return null;
  if (state.ended) return { ended: true };
  const { video, canvas } = state;
  if (!video.videoWidth) return null;
  const scale = Math.min(1, ${options.maxWidth} / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return { seq: ++state.seq, url: canvas.toDataURL(${JSON.stringify(options.mimeType)}, ${options.quality ?? 0.72}), width: canvas.width, height: canvas.height };
})()`;

const STOP = `(() => { globalThis.__tauCapture?.stream.getTracks().forEach((track) => track.stop()); globalThis.__tauCapture = undefined; })()`;

/**
 * The session hands the page the window's capture source and nothing else. A
 * caller starts it only once the system already allows it, so it never raises
 * the permission prompt.
 */
export class WindowCapture {
  private view: WebContentsView | undefined;

  constructor(readonly windowId: number, private readonly options: WindowCaptureOptions) {}

  async start(): Promise<void> {
    const source = windowSourceId(this.windowId);
    let armed = true;
    // The handler answers this one request, then refuses.
    session.fromPartition(this.options.partition).setDisplayMediaRequestHandler((_request, callback) => {
      if (!armed) {
        callback({});
        return;
      }
      armed = false;
      callback({ video: { id: source, name: "Captured window" } as DesktopCapturerSource });
    });
    const view = new WebContentsView({
      webPreferences: { partition: this.options.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.view = view;
    try {
      await view.webContents.loadFile(await pageFile());
      await view.webContents.executeJavaScript(startScript(this.options.frameRate ?? 4), true);
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      armed = false;
    }
  }

  async take(): Promise<WindowFrame | { ended: true } | null> {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return { ended: true };
    return await contents.executeJavaScript(takeScript(this.options)) as WindowFrame | { ended: true } | null;
  }

  stop(): void {
    const contents = this.view?.webContents;
    this.view = undefined;
    if (!contents || contents.isDestroyed()) return;
    void contents.executeJavaScript(STOP).catch(() => undefined).finally(() => { if (!contents.isDestroyed()) contents.close(); });
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One frame of one window: starts a recording, takes its first frame and stops. */
export async function captureWindowOnce(
  capture: Pick<WindowCapture, "start" | "take" | "stop">,
  { timeoutMs = 4_000, pollMs = 50, pause = wait }: { timeoutMs?: number; pollMs?: number; pause?: (ms: number) => Promise<void> } = {},
): Promise<WindowFrame> {
  await capture.start();
  try {
    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      const frame = await capture.take();
      if (frame && "ended" in frame) throw new Error("The window closed before it could be captured.");
      if (frame) return frame;
      await pause(pollMs);
    }
    throw new Error("The window gave no picture in time.");
  } finally {
    capture.stop();
  }
}
