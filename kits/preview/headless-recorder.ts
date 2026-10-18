import type { PreviewRecordingChunks } from "./host.js";

type Send = <T>(method: string, params?: object) => Promise<T>;
interface Part { data: string; base64Encoded: boolean; eof: boolean }
const READ_BYTES = 64 * 1024;
const MAX_DRAIN_BYTES = 16 * 1024 * 1024;
const MIME = "video/mp4";

/** Chromium owns the encoder and temporary stream; no page script or external encoder. */
export class HeadlessPreviewRecorder {
  private stream: string | undefined;
  private received = false;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly send: Send) {}

  record(action: "start" | "take" | "stop", options?: { frameRate?: number }): Promise<PreviewRecordingChunks> {
    if (this.disposed) return Promise.reject(new Error("The preview recorder is closed."));
    const result = this.queue.then(() => this.run(action, options));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(action: "start" | "take" | "stop", options?: { frameRate?: number }): Promise<PreviewRecordingChunks> {
    if (action === "start") {
      if (this.stream) return { chunks: [], mimeType: MIME };
      const rate = Math.round(options?.frameRate ?? 30);
      let answer: { stream: string };
      try {
        answer = await this.send("Page.startScreenRecording", { audio: false, maxWidth: 1920, maxHeight: 1920, frameRate: Number.isFinite(rate) ? Math.min(60, Math.max(1, rate)) : 30 });
      } catch (error) {
        if (error instanceof Error && /wasn't found|not found|without AV1/iu.test(error.message)) throw new Error("Video recording without a desktop window needs Chrome/Chromium 153 or newer with AV1 recording support.", { cause: error });
        throw error;
      }
      if (typeof answer.stream !== "string" || !answer.stream) {
        await this.send<{ stream?: string }>("Page.stopScreenRecording").then(async (stopped) => {
          if (stopped.stream) await this.send("IO.close", { handle: stopped.stream });
        }).catch(() => undefined);
        throw new Error("The preview browser did not return a recording stream.");
      }
      this.stream = answer.stream;
      this.received = false;
      return { chunks: [], mimeType: MIME };
    }
    const handle = this.stream;
    if (!handle) return { chunks: [], mimeType: MIME };
    if (action === "take") return { chunks: await this.read(handle, false), mimeType: MIME };
    try {
      await this.send("Page.stopScreenRecording");
      const chunks = await this.read(handle, true);
      if (!this.received) throw new Error("The recording contains no video data.");
      return { chunks, mimeType: MIME };
    } finally {
      this.stream = undefined;
      await this.send("IO.close", { handle }).catch(() => undefined);
    }
  }

  private async read(handle: string, final: boolean): Promise<string[]> {
    const chunks: string[] = [];
    let bytes = 0;
    while (bytes < MAX_DRAIN_BYTES) {
      let part: Part;
      try {
        // oxlint-disable-next-line no-await-in-loop -- the stream has one advancing cursor
        part = await this.send("IO.read", { handle, size: READ_BYTES });
      } catch (error) {
        // Chrome creates the backing file on the first encoded frame. An early
        // poll may precede it; after any data, a read failure is a real failure.
        if (!final && !this.received && error instanceof Error && error.message === "Read failed") return chunks;
        throw error;
      }
      if (typeof part.data !== "string" || part.base64Encoded !== true || part.data.length > Math.ceil(READ_BYTES / 3) * 4 || !/^[a-z0-9+/]*={0,2}$/iu.test(part.data)) throw new Error("The preview browser sent invalid recording data.");
      if (part.data) { chunks.push(part.data); bytes += Buffer.from(part.data, "base64").length; this.received = true; }
      // A live file's EOF only means caught up, not that recording has ended.
      if (part.eof || !part.data) return chunks;
    }
    if (final) throw new Error("The recording has too much undrained data to finish safely.");
    return chunks;
  }

  /** Closing the surface discards an uncollected recording and releases its stream. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue;
    const handle = this.stream;
    this.stream = undefined;
    if (!handle) return;
    await this.send("Page.stopScreenRecording").catch(() => undefined);
    await this.send("IO.close", { handle }).catch(() => undefined);
  }
}
