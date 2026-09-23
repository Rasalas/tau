import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { commandInvocation, killProcessTree } from "tau/host-extension";

/**
 * The app-server wire: one JSON-RPC message per line on the CLI's stdin and
 * stdout, without the `jsonrpc` field. Tau sends requests and notifications,
 * answers the server's requests through one handler, and hands every
 * notification to one listener.
 */
export interface RpcProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface RpcSpawnInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function spawnRpcProcess(input: RpcSpawnInput): RpcProcess {
  const invocation = commandInvocation(input.command, input.args, { env: input.env });
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  // `close` rather than `exit`: by then stderr is drained, so the exit message can quote it.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return {
    get pid() { return child.pid; },
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    // An npm shim runs under cmd.exe on Windows; ending only cmd.exe would orphan the CLI.
    kill: (signal) => {
      if (process.platform !== "win32" || child.pid === undefined || child.exitCode !== null) return child.kill(signal);
      killProcessTree(child.pid);
      return true;
    },
    exited,
  };
}

export class RpcError extends Error {
  readonly name = "RpcError";
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export class RpcClosedError extends Error {
  readonly name = "RpcClosedError";
}

export type RequestId = number | string;
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface RpcConnectionOptions {
  process: RpcProcess;
  onNotification(method: string, params: unknown): void;
  onRequest: ServerRequestHandler;
  onStderrLine?(line: string): void;
  /** The process ended; `error` is undefined when Tau closed it. */
  onExit?(error: RpcClosedError | undefined): void;
}

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_METHOD_NOT_FOUND = -32601;

/** Splits a byte stream into lines, dropping one that grows past `max`. */
export function lineSplitter(max: number, onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = Buffer.alloc(0);
  let skipping = false;
  return (chunk) => {
    let buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (skipping) { skipping = false; continue; }
      onLine(line.toString("utf8").replace(/\r$/u, ""));
    }
    if (buffer.length > max) { skipping = true; rest = Buffer.alloc(0); } else rest = Buffer.from(buffer);
  };
}

interface Pending { method: string; resolve(value: unknown): void; reject(error: Error): void }

export class RpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError?: RpcClosedError;
  private closing = false;
  private stderrTail = "";

  constructor(private readonly options: RpcConnectionOptions) {
    options.process.stdout.on("data", lineSplitter(MAX_LINE_BYTES, (line) => this.onLine(line)));
    options.process.stderr.on("data", lineSplitter(STDERR_TAIL, (line) => {
      this.stderrTail = `${this.stderrTail}${line}\n`.slice(-STDERR_TAIL);
      options.onStderrLine?.(line);
    }));
    options.process.stdin.on("error", () => undefined);
    void options.process.exited.then(({ code, signal }) => {
      if (this.closing) { this.finish(undefined); return; }
      const detail = this.stderrTail.trim();
      this.finish(new RpcClosedError(`Codex exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}.${detail ? `\n${detail}` : ""}`));
    });
  }

  get closed(): boolean { return this.closing || this.closedError !== undefined; }
  get stderr(): string { return this.stderrTail; }

  request<T = unknown>(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closedError ?? new RpcClosedError("The Codex session is closing."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = options.timeoutMs
        ? setTimeout(() => { this.pending.delete(id); reject(new RpcError(method, RPC_INTERNAL_ERROR, `Codex did not answer ${method} within ${Math.round(options.timeoutMs! / 1000)} s.`)); }, options.timeoutMs)
        : undefined;
      timer?.unref?.();
      this.pending.set(id, {
        method,
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value as T); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write(params === undefined ? { method } : { method, params });
  }

  /** Ends stdin and waits for the exit; a process that lingers is terminated, then killed. */
  async close(graceMs = 1_000): Promise<void> {
    if (this.closedError) return;
    this.closing = true;
    try { this.options.process.stdin.end(); } catch { /* already gone */ }
    const exited = this.options.process.exited.then(() => true);
    const wait = (ms: number) => new Promise<false>((resolve) => setTimeout(() => resolve(false), ms).unref?.());
    if (await Promise.race([exited, wait(graceMs)])) return;
    this.options.process.kill("SIGTERM");
    if (await Promise.race([exited, wait(graceMs)])) return;
    this.options.process.kill("SIGKILL");
    await exited;
  }

  private write(message: object): void {
    try {
      this.options.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.options.process.kill("SIGKILL");
      this.finish(new RpcClosedError(`Codex's input closed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof message.method === "string") {
      if (hasId) void this.serve(id as RequestId, message.method, message.params);
      else this.options.onNotification(message.method, message.params);
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = message.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (error && typeof error === "object") {
      pending.reject(new RpcError(pending.method, typeof error.code === "number" ? error.code : RPC_INTERNAL_ERROR, typeof error.message === "string" ? error.message : "Codex returned an error.", error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private async serve(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ id, result: result ?? {} });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : RPC_INTERNAL_ERROR;
      this.write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private finish(error: RpcClosedError | undefined): void {
    if (this.closedError) return;
    this.closedError = error ?? new RpcClosedError("The Codex session was closed.");
    for (const pending of [...this.pending.values()]) pending.reject(this.closedError);
    this.pending.clear();
    this.options.onExit?.(error);
  }
}
