import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * The Agent Client Protocol wire: newline-delimited JSON-RPC 2.0 on the
 * agent's stdin and stdout. Tau sends requests and notifications, answers
 * the agent's requests through registered handlers, and hands every
 * `session/update` to one listener. Lines that are not JSON (the agent's
 * sign-in hint, for one) go to the line hook before they are dropped.
 */
export interface AcpProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  /** Resolves once the process has exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface AcpSpawnInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export function spawnAcpProcess(input: AcpSpawnInput): AcpProcess {
  const child = spawn(input.command, [...input.args], { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return {
    get pid() { return child.pid; },
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill: (signal) => child.kill(signal),
    exited,
  };
}

export class AcpRequestError extends Error {
  readonly name = "AcpRequestError";
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export class AcpExitedError extends Error {
  readonly name = "AcpExitedError";
}

export type AcpRequestHandler = (params: unknown) => Promise<unknown> | unknown;

export interface AcpClientOptions {
  process: AcpProcess;
  onNotification(method: string, params: unknown): void;
  /** A stdout line that is not JSON-RPC; return true to say it was meant for Tau. */
  onStdoutLine?(line: string): boolean | void;
  onStderrLine?(line: string): void;
  onExit?(error: AcpExitedError | undefined): void;
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE = 16 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;
/** ACP error codes Tau answers with when it cannot serve a request. */
export const ACP_METHOD_NOT_FOUND = -32601;
export const ACP_INVALID_PARAMS = -32602;
export const ACP_INTERNAL_ERROR = -32603;
export const ACP_AUTH_REQUIRED = -32000;
export const ACP_RESOURCE_NOT_FOUND = -32002;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Splits a byte stream into lines, holding at most `max` bytes of an unfinished one. */
export function lineSplitter(max: number, onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void {
  let rest = Buffer.alloc(0);
  let overflowed = false;
  return (chunk: Buffer) => {
    let buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (overflowed) { overflowed = false; continue; }
      onLine(line.toString("utf8").replace(/\r$/u, ""));
    }
    if (buffer.length > max) {
      overflowed = true;
      onOverflow();
      rest = Buffer.alloc(0);
    } else {
      rest = Buffer.from(buffer);
    }
  };
}

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, AcpRequestHandler>();
  private exitError?: AcpExitedError;
  private stderrTail = "";
  private closing = false;

  constructor(private readonly options: AcpClientOptions) {
    const max = options.maxLineBytes ?? DEFAULT_MAX_LINE;
    const stdout = lineSplitter(max, (line) => this.onLine(line), () => this.fail(new AcpExitedError("Antigravity sent a line longer than Tau reads.")));
    const stderr = lineSplitter(STDERR_TAIL, (line) => {
      this.stderrTail = `${this.stderrTail}${line}\n`.slice(-STDERR_TAIL);
      options.onStderrLine?.(line);
    }, () => undefined);
    options.process.stdout.on("data", (chunk: Buffer) => stdout(chunk));
    options.process.stderr.on("data", (chunk: Buffer) => stderr(chunk));
    void options.process.exited.then(({ code, signal }) => {
      if (this.closing && !this.exitError) { this.finish(undefined); return; }
      const detail = this.stderrTail.trim();
      this.finish(new AcpExitedError(`Antigravity exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}.${detail ? `\n${detail}` : ""}`));
    });
    options.process.stdin.on("error", () => undefined);
  }

  get closed(): boolean { return this.exitError !== undefined || this.closing; }
  get pid(): number | undefined { return this.options.process.pid; }
  get stderr(): string { return this.stderrTail; }

  /** Answers the agent's requests of this method; the last registration wins. */
  handle(method: string, handler: AcpRequestHandler): () => void {
    this.handlers.set(method, handler);
    return () => { if (this.handlers.get(method) === handler) this.handlers.delete(method); };
  }

  request<T = unknown>(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (this.closing) return Promise.reject(new AcpExitedError("The Antigravity session is closing."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (fn: () => void) => { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); this.pending.delete(id); fn(); };
      const onAbort = () => settle(() => reject(new AcpRequestError(method, ACP_INTERNAL_ERROR, "The request was aborted.")));
      this.pending.set(id, { method, resolve: (value) => settle(() => resolve(value as T)), reject: (error) => settle(() => reject(error)) });
      if (options.timeoutMs) timer = setTimeout(() => settle(() => reject(new AcpRequestError(method, ACP_INTERNAL_ERROR, `Antigravity did not answer ${method} within ${Math.round(options.timeoutMs! / 1000)} s.`))), options.timeoutMs);
      timer?.unref?.();
      if (options.signal?.aborted) { onAbort(); return; }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** A notification carries no id; an agent that saw one would drop it as malformed. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends stdin and waits for the exit; a process that lingers is killed after the grace period. */
  async close(graceMs = 1_000): Promise<void> {
    if (this.exitError) return;
    this.closing = true;
    try { this.options.process.stdin.end(); } catch { /* already gone */ }
    const exited = this.options.process.exited.then(() => true);
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs).unref?.());
    if (!await Promise.race([exited, timeout])) {
      this.options.process.kill("SIGTERM");
      const killed = new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs).unref?.());
      if (!await Promise.race([exited, killed])) this.options.process.kill("SIGKILL");
      await exited;
    }
  }

  private write(message: object): void {
    try {
      this.options.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(new AcpExitedError(`Antigravity's input closed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      this.options.onStdoutLine?.(line);
      return;
    }
    const id = message.id;
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof message.method === "string") {
      if (hasId) void this.serve(id as number | string, message.method, message.params);
      else this.options.onNotification(message.method, message.params);
      return;
    }
    if (!hasId || typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.error && typeof message.error === "object") {
      const error = message.error as { code?: unknown; message?: unknown; data?: unknown };
      pending.reject(new AcpRequestError(pending.method, typeof error.code === "number" ? error.code : ACP_INTERNAL_ERROR, typeof error.message === "string" ? error.message : "Antigravity returned an error.", error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private async serve(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: ACP_METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (error) {
      const code = error instanceof AcpRequestError ? error.code : ACP_INTERNAL_ERROR;
      this.write({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private fail(error: AcpExitedError): void {
    if (this.exitError) return;
    this.exitError = error;
    this.options.process.kill("SIGKILL");
    this.finish(error);
  }

  private finish(error: AcpExitedError | undefined): void {
    if (error && !this.exitError) this.exitError = error;
    if (!error && !this.exitError) this.exitError = new AcpExitedError("The Antigravity session was closed.");
    const failure = error ?? new AcpExitedError("The Antigravity session was closed.");
    for (const pending of [...this.pending.values()]) pending.reject(failure);
    this.pending.clear();
    this.options.onExit?.(error);
  }
}
