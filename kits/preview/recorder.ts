import { WebContentsView, session, type WebContents } from "electron";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewRecordingChunks } from "./host.js";

/** In memory only: the recorder page keeps nothing. */
const RECORDER_PARTITION = "tau-preview-recorder";

/**
 * `getDisplayMedia` needs a secure context, which `about:blank` and `data:`
 * are not; a file is. It holds no code: the scripts below are sent to it.
 */
let helperPage: Promise<string> | undefined;
const recorderPage = (): Promise<string> => helperPage ??= (async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-preview-"));
  const file = join(directory, "recorder.html");
  await writeFile(file, "<!doctype html><meta charset=\"utf-8\"><title>Tau preview recorder</title>");
  return file;
})();

const START = `(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: { max: 1920 }, height: { max: 1920 } }, audio: false });
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  recorder.start(1000);
  globalThis.__tauRecorder = { recorder, stream, chunks };
  return recorder.mimeType || type || "video/webm";
})()`;

const TAKE = `(async () => {
  const state = globalThis.__tauRecorder;
  if (!state) return [];
  const out = [];
  for (const blob of state.chunks.splice(0)) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    out.push(btoa(binary));
  }
  return out;
})()`;

const STOP = `(async () => {
  const state = globalThis.__tauRecorder;
  if (!state) return;
  if (state.recorder.state !== "inactive") await new Promise((resolve) => { state.recorder.onstop = resolve; state.recorder.stop(); });
  state.stream.getTracks().forEach((track) => track.stop());
})()`;

/**
 * Records one preview view to webm. A hidden page of its own asks for display
 * media, the session hands it the preview's frame (tab capture), and a
 * `MediaRecorder` there cuts one-second chunks the host collects with `take`.
 */
export class PreviewRecorder {
  private helper: WebContentsView | undefined;

  private mimeType = "video/webm";

  constructor(private readonly target: WebContents) {}

  async start(): Promise<PreviewRecordingChunks> {
    if (this.helper) return { chunks: [], mimeType: this.mimeType };
    let armed = true;
    // The handler is the partition's, not this recorder's: it answers one request, then nothing.
    session.fromPartition(RECORDER_PARTITION).setDisplayMediaRequestHandler((_request, callback) => {
      if (!armed || this.target.isDestroyed()) {
        callback({});
        return;
      }
      armed = false;
      callback({ video: this.target.mainFrame });
    });
    const helper = new WebContentsView({
      webPreferences: { partition: RECORDER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.helper = helper;
    try {
      await helper.webContents.loadFile(await recorderPage());
      this.mimeType = String(await helper.webContents.executeJavaScript(START, true));
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      armed = false;
    }
    return { chunks: [], mimeType: this.mimeType };
  }

  async take(): Promise<PreviewRecordingChunks> {
    const contents = this.helper?.webContents;
    if (!contents || contents.isDestroyed()) return { chunks: [], mimeType: this.mimeType };
    const chunks: unknown = await contents.executeJavaScript(TAKE);
    return { chunks: Array.isArray(chunks) ? chunks.filter((chunk): chunk is string => typeof chunk === "string") : [], mimeType: this.mimeType };
  }

  async stop(): Promise<PreviewRecordingChunks> {
    const contents = this.helper?.webContents;
    if (!contents || contents.isDestroyed()) return { chunks: [], mimeType: this.mimeType };
    try {
      await contents.executeJavaScript(STOP);
      return await this.take();
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    const contents = this.helper?.webContents;
    this.helper = undefined;
    if (contents && !contents.isDestroyed()) contents.close();
  }
}
