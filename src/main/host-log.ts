import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** What PiHost and index.ts write through; kept free of Electron so it stays testable with plain Node. */
export interface HostLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
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
  private ready: boolean;

  constructor(options: HostLogOptions) {
    this.filePath = join(options.dir, options.fileName ?? "host.log");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.mirror = options.mirrorToConsole ?? Boolean(process.env.TAU_DEV_SERVER_URL || process.env.TAU_LOG_STDERR === "1");
    try {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 });
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  debug(message: string, detail?: unknown): void { this.write("debug", message, detail); }
  info(message: string, detail?: unknown): void { this.write("info", message, detail); }
  warn(message: string, detail?: unknown): void { this.write("warn", message, detail); }
  error(message: string, detail?: unknown): void { this.write("error", message, detail); }

  private write(level: LogLevel, message: string, detail?: unknown): void {
    const detailJson = serializeDetail(detail);
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${detailJson ? ` ${detailJson}` : ""}`;
    if (this.mirror) (level === "error" || level === "warn" ? console.error : console.log)(line);
    if (!this.ready) return;
    try {
      this.rotateIfNeeded();
      appendFileSync(this.filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // The console mirror above (or silence) is the fallback; a log write must never throw.
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes) return;
    try {
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // Best effort; keep appending to the existing file if rotation fails.
    }
  }
}
