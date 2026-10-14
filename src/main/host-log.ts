import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** What PiHost and index.ts write through; kept free of Electron so it stays testable with plain Node. */
export interface HostLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  /** Emergency drain immediately before a fatal process exit, never for routine logging. */
  flushSync?(): void;
}

export interface HostLogOptions {
  /** Directory the log file lives in, e.g. `<userData>/logs`. Created 0o700. */
  dir: string;
  fileName?: string;
  /** Bytes at which the file rotates to `<fileName>.1`; defaults to 5 MB. */
  maxBytes?: number;
  /** Mirror every line to the console; defaults to TAU_DEV_SERVER_URL or TAU_LOG_STDERR=1. */
  mirrorToConsole?: boolean;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function describeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause !== undefined ? { cause: error.cause instanceof Error ? describeError(error.cause) : error.cause } : {}),
  };
}

function serializeDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  try {
    return JSON.stringify(detail instanceof Error ? describeError(detail) : detail);
  } catch {
    return JSON.stringify(String(detail));
  }
}

/**
 * A small file-backed logger. Every write is best-effort: a log call must
 * never throw or block the caller on a broken or unwritable log directory.
 */
export class HostLog implements HostLogger {
  readonly filePath: string;
  private readonly maxBytes: number;
  private readonly mirror: boolean;
  private readonly prepared: Promise<boolean>;
  private queue: string[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private size = 0;
  private writing?: Promise<void>;
  private inFlight = "";
  private readonly dir: string;

  constructor(options: HostLogOptions) {
    this.filePath = join(options.dir, options.fileName ?? "host.log");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.mirror = options.mirrorToConsole ?? Boolean(process.env.TAU_DEV_SERVER_URL || process.env.TAU_LOG_STDERR === "1");
    this.dir = options.dir;
    this.prepared = mkdir(options.dir, { recursive: true, mode: 0o700 }).then(async () => {
      this.size = await stat(this.filePath).then((info) => info.size, () => 0);
      return true;
    }, () => false);
  }

  debug(message: string, detail?: unknown): void { this.write("debug", message, detail); }
  info(message: string, detail?: unknown): void { this.write("info", message, detail); }
  warn(message: string, detail?: unknown): void { this.write("warn", message, detail); }
  error(message: string, detail?: unknown): void { this.write("error", message, detail); }

  private write(level: LogLevel, message: string, detail?: unknown): void {
    const detailJson = serializeDetail(detail);
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${detailJson ? ` ${detailJson}` : ""}`;
    if (this.mirror) (level === "error" || level === "warn" ? console.error : console.log)(line);
    // A stalled disk must not turn logging into an unbounded memory queue.
    const bytes = Buffer.byteLength(line) + 1;
    if (this.queuedBytes + bytes > 2 * 1024 * 1024) this.dropped++;
    else { this.queue.push(`${line}\n`); this.queuedBytes += bytes; }
    this.schedule();
  }

  /** Waits for queued lines; normal shutdown awaits this before exiting. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  /** Only a fatal exception uses synchronous I/O, since process.exit cannot drain async work. */
  flushSync(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const text = this.inFlight + this.queue.join("") + this.droppedLine();
      if (text) appendFileSync(this.filePath, text, { encoding: "utf8", mode: 0o600 });
      this.queue = [];
      this.queuedBytes = 0;
    } catch { /* A failing log must never hide the fatal error. */ }
  }

  private droppedLine(): string {
    if (!this.dropped) return "";
    const line = `${new Date().toISOString()} WARN log.backpressure ${this.dropped} lines dropped\n`;
    this.dropped = 0;
    return line;
  }

  private schedule(): void {
    if (this.writing) return;
    this.writing = Promise.resolve().then(() => this.drain()).finally(() => {
      this.writing = undefined;
      if (this.queue.length || this.dropped) this.schedule();
    });
  }

  private async drain(): Promise<void> {
    if (!await this.prepared) { this.queue = []; this.queuedBytes = 0; this.dropped = 0; return; }
    while (this.queue.length || this.dropped) {
      if (this.size > this.maxBytes) {
        try { await rename(this.filePath, `${this.filePath}.1`); this.size = 0; }
        catch { /* Keep appending if rotation fails. */ }
      }
      let bytes = 0;
      let count = 0;
      const limit = Math.max(1, Math.min(64 * 1024, this.maxBytes - this.size));
      while (count < this.queue.length && (count === 0 || bytes < limit)) {
        bytes += Buffer.byteLength(this.queue[count]!);
        count++;
      }
      this.inFlight = this.queue.splice(0, count).join("") + this.droppedLine();
      this.queuedBytes -= bytes;
      try {
        await appendFile(this.filePath, this.inFlight, { encoding: "utf8", mode: 0o600 });
        this.size += Buffer.byteLength(this.inFlight);
      } catch { /* Best effort: log failures never fail the host's work. */ }
      finally { this.inFlight = ""; }
    }
  }
}
