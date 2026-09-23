import { PassThrough } from "node:stream";
import type { AcpProcess } from "./client.js";

/**
 * A fake agent process for tests: Tau writes to `stdin`, the script answers
 * on `stdout`. `agent.send` pushes a message the agent originates.
 */
export interface FakeAgent {
  process: AcpProcess;
  /** Every message Tau wrote, parsed. */
  received: Array<Record<string, unknown>>;
  /** Raw lines Tau wrote, including non-JSON. */
  lines: string[];
  send(message: object): void;
  sendRaw(line: string): void;
  stderr(line: string): void;
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
  /** Answer requests by method; return `{ error }` to fail one. */
  respond(method: string, handler: (params: unknown, id: number) => unknown | Promise<unknown>): void;
  /** Resolves the next request of a method, with its id and params. */
  nextRequest(method: string): Promise<{ id: number; params: unknown }>;
}

export function fakeAgent(): FakeAgent {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve; });
  const received: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const responders = new Map<string, (params: unknown, id: number) => unknown | Promise<unknown>>();
  const waiters = new Map<string, Array<(request: { id: number; params: unknown }) => void>>();
  let rest = "";
  stdin.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline < 0) break;
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      lines.push(line);
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      received.push(message);
      const method = typeof message.method === "string" ? message.method : undefined;
      const id = typeof message.id === "number" ? message.id : undefined;
      if (method && id !== undefined) {
        const waiting = waiters.get(method)?.shift();
        if (waiting) waiting({ id, params: message.params });
        const responder = responders.get(method);
        if (responder) {
          void Promise.resolve(responder(message.params, id)).then((result) => {
            const failure = result && typeof result === "object" && "error" in (result as object) ? (result as { error: unknown }).error : undefined;
            const reply = failure ? { jsonrpc: "2.0", id, error: failure } : { jsonrpc: "2.0", id, result: result ?? {} };
            stdout.write(`${JSON.stringify(reply)}\n`);
          });
        }
      }
    }
  });
  let exitedFlag = false;
  stdin.on("end", () => { if (!exitedFlag) { exitedFlag = true; resolveExit({ code: 0, signal: null }); } });
  const process: AcpProcess = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    kill: () => { if (!exitedFlag) { exitedFlag = true; resolveExit({ code: null, signal: "SIGKILL" }); } return true; },
    exited,
  };
  return {
    process,
    received,
    lines,
    send: (message) => { stdout.write(`${JSON.stringify(message)}\n`); },
    sendRaw: (line) => { stdout.write(`${line}\n`); },
    stderr: (line) => { stderr.write(`${line}\n`); },
    exit: (code = 0, signal = null) => { if (!exitedFlag) { exitedFlag = true; resolveExit({ code, signal }); } },
    respond: (method, handler) => { responders.set(method, handler); },
    nextRequest: (method) => new Promise((resolve) => { waiters.set(method, [...(waiters.get(method) ?? []), resolve]); }),
  };
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
export async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
