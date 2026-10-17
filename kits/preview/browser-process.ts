import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

type Event = { method: string; params: Record<string, unknown>; sessionId?: string };

/** A private DevTools pipe to one owned Chromium process, never a listening port. */
export class PreviewBrowserProcess {
  private readonly child: ChildProcess;
  private readonly input: Writable;
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private stopped = false;
  readonly exited: Promise<void>;

  constructor(executable: string, profile: string) {
    this.child = spawn(executable, [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
      "--no-startup-window", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--disable-default-apps",
      "--disable-sync", "--password-store=basic",
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    this.input = this.child.stdio[3] as Writable;
    const output = this.child.stdio[4] as Readable;
    // Drain diagnostics without logging page URLs or other browser data.
    this.child.stderr?.resume();
    let buffer = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) { this.fail(new Error("The preview browser response is too large.")); this.child.kill("SIGTERM"); return; }
      let end: number;
      while ((end = buffer.indexOf("\0")) !== -1) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(message) as Event & { id?: number; result?: unknown; error?: { message: string } };
          if (frame.id !== undefined) {
            const call = this.pending.get(frame.id);
            if (!call) continue;
            this.pending.delete(frame.id);
            clearTimeout(call.timer);
            if (frame.error) call.reject(new Error(frame.error.message));
            else call.resolve(frame.result);
          } else for (const listener of this.listeners) listener(frame);
        } catch { this.fail(new Error("The preview browser sent an invalid response.")); }
      }
    });
    this.input.on("error", () => this.fail(new Error("The preview browser pipe closed.")));
    output.on("error", () => this.fail(new Error("The preview browser pipe closed.")));
    this.child.on("error", () => this.fail(new Error("The preview browser could not start. Check TAU_PREVIEW_BROWSER and Chromium's sandbox setup.")));
    this.exited = new Promise((resolve) => this.child.once("close", () => {
      this.fail(new Error("The preview browser closed."));
      resolve();
    }));
  }

  onEvent(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("The preview browser is closed."));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The preview browser timed out: ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  private fail(error: Error): void {
    this.stopped = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
    // Browser.close flushes the owned profile before terminating Chromium.
    await this.send("Browser.close", {}, undefined, 2_000).catch(() => undefined);
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 2_000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 4_000);
    try { await this.exited; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
}
