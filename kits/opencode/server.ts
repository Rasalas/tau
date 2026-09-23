import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { commandInvocation, killProcessTree } from "tau/host-extension";
import { OpenCodeClient } from "./client.js";

/**
 * A local `opencode serve` Tau starts, bound to 127.0.0.1 on a port it picks
 * itself and closed with the thread (or probe) that asked for it. Every such
 * server gets a fresh password, so nothing else on the machine can drive it.
 */

export interface OpenCodeServerHandle {
  readonly url: string;
  readonly password?: string;
  /** Tau started the process; an external server is only connected to. */
  readonly local: boolean;
  readonly client: OpenCodeClient;
  readonly closed: boolean;
  close(): Promise<void>;
}

export interface OpenCodeServeInput {
  command: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Merged into `OPENCODE_CONFIG_CONTENT` on top of what the environment already sets. */
  config?: Record<string, unknown>;
  onExit?(error: Error | undefined): void;
  onStderrLine?(line: string): void;
  timeoutMs?: number;
  /** How long `close` waits after SIGTERM before it kills. */
  closeGraceMs?: number;
  fetch?: typeof globalThis.fetch;
}

const READY = /opencode server listening on (https?:\/\/\S+)/u;
const OUTPUT_TAIL = 8 * 1024;
/** A server still at work may ignore SIGTERM for seconds; after this it is killed. */
const CLOSE_GRACE_MS = 2_000;

/** The user's own `OPENCODE_CONFIG_CONTENT`, with Tau's keys laid over it one level deep. */
export function mergedConfigContent(existing: string | undefined, config: Record<string, unknown> | undefined): string | undefined {
  if (!config) return existing;
  let base: Record<string, unknown> = {};
  try {
    const parsed = existing ? JSON.parse(existing) as unknown : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch { /* an unreadable value is replaced */ }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(config)) {
    const before = base[key];
    merged[key] = before && typeof before === "object" && !Array.isArray(before) && value && typeof value === "object" && !Array.isArray(value)
      ? { ...before as Record<string, unknown>, ...value as Record<string, unknown> }
      : value;
  }
  return JSON.stringify(merged);
}

/** Starts `opencode serve` and waits for the line that names its address. */
export function startOpenCodeServer(input: OpenCodeServeInput): Promise<OpenCodeServerHandle> {
  const password = randomBytes(24).toString("base64url");
  const configContent = mergedConfigContent(input.env.OPENCODE_CONFIG_CONTENT, input.config);
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    OPENCODE_SERVER_PASSWORD: password,
    ...(configContent ? { OPENCODE_CONFIG_CONTENT: configContent } : {}),
  };
  delete env.OPENCODE_SERVER_USERNAME;
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0", ...(input.args ?? [])];
  const invocation = commandInvocation(input.command, args, { env });
  const child: ChildProcess = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so closing it also ends the MCP servers and LSPs it started.
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  let output = "";
  let closedByTau = false;
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  const tail = (chunk: string) => { output = `${output}${chunk}`.slice(-OUTPUT_TAIL); };

  return new Promise<OpenCodeServerHandle>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      fail(new Error(`OpenCode did not start its server within ${Math.round((input.timeoutMs ?? 30_000) / 1000)} s.${output.trim() ? `\n${output.trim()}` : ""}`));
    }, input.timeoutMs ?? 30_000);
    timer.unref?.();
    const fail = (error: Error) => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };
    const stop = () => {
      if (exited || child.pid === undefined) return;
      killProcessTree(child.pid);
    };
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    let stdoutBuffer = "";
    child.stdout!.on("data", (chunk: string) => {
      if (ready) return;
      stdoutBuffer += chunk;
      tail(chunk);
      const match = READY.exec(stdoutBuffer);
      if (!match) return;
      ready = true;
      clearTimeout(timer);
      const url = match[1]!;
      const client = new OpenCodeClient({ url, password, ...(input.fetch ? { fetch: input.fetch } : {}) });
      resolve({
        url,
        password,
        local: true,
        client,
        get closed() { return exited || closedByTau; },
        close: async () => {
          if (closedByTau) return exit;
          closedByTau = true;
          stop();
          const grace = new Promise<boolean>((done) => setTimeout(() => done(false), input.closeGraceMs ?? CLOSE_GRACE_MS).unref?.());
          if (!await Promise.race([exit.then(() => true), grace]) && child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
          await exit;
        },
      });
    });
    let stderrLine = "";
    child.stderr!.on("data", (chunk: string) => {
      tail(chunk);
      stderrLine += chunk;
      const lines = stderrLine.split(/\r?\n/u);
      stderrLine = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) input.onStderrLine?.(line);
    });
    child.once("error", (error) => fail(new Error(`OpenCode could not be started: ${error.message}`)));
    child.once("close", (code, signal) => {
      exited = true;
      const reason = new Error(`OpenCode's server exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}.${output.trim() ? `\n${output.trim().slice(-2_000)}` : ""}`);
      if (!ready) return fail(reason);
      input.onExit?.(closedByTau ? undefined : reason);
    });
  });
}

/** An OpenCode server the user runs, reached by URL and password; its version is checked here. */
export async function connectOpenCodeServer(url: string, password: string | undefined, fetcher?: typeof globalThis.fetch): Promise<OpenCodeServerHandle> {
  const client = new OpenCodeClient({ url, ...(password ? { password } : {}), ...(fetcher ? { fetch: fetcher } : {}) });
  await client.health();
  let closed = false;
  return {
    url: client.url,
    ...(password ? { password } : {}),
    local: false,
    client,
    get closed() { return closed; },
    close: async () => { closed = true; },
  };
}
