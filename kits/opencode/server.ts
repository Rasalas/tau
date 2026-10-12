import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { AGENT_OOM_MESSAGE, commandInvocation, killProcessTree, wrapAgentCommand } from "tau/host-extension";
import type { OpenCodeApi } from "./api.js";
import { connectOpenCodeApi } from "./connect.js";

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
  /** MCP servers Tau put in the server's config, whose tools a thread waits for. */
  readonly mcpServers?: readonly string[];
  /** The server's HTTP API, whichever generation answered. */
  readonly api: OpenCodeApi;
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
  /** Starts the process; tests hand in a recorder. */
  wrap?: typeof wrapAgentCommand;
}

// OpenCode 1 prints "opencode server listening on", OpenCode 2 "server listening on".
const READY = /server listening on (https?:\/\/\S+)/u;
const OUTPUT_TAIL = 8 * 1024;
/** A server still at work may ignore SIGTERM for seconds; after this it is killed. */
const CLOSE_GRACE_MS = 2_000;

/** One level of a config key; OpenCode 2's `mcp.servers` is one level deeper. */
function mergedObject(before: Record<string, unknown>, value: Record<string, unknown>, key: string): Record<string, unknown> {
  const merged = { ...before, ...value };
  const [mine, ours] = [before.servers, value.servers];
  if (key === "mcp" && mine && ours && typeof mine === "object" && typeof ours === "object") merged.servers = { ...mine, ...ours };
  return merged;
}

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
      ? mergedObject(before as Record<string, unknown>, value as Record<string, unknown>, key)
      : value;
  }
  return JSON.stringify(merged);
}

/** The names of the MCP servers a config adds, in either generation's shape. */
function mcpServerNames(config: Record<string, unknown> | undefined): string[] | undefined {
  const mcp = config?.mcp;
  if (!mcp || typeof mcp !== "object") return undefined;
  const servers = (mcp as { servers?: unknown }).servers;
  const names = Object.keys(servers && typeof servers === "object" ? servers : mcp);
  return names.length ? names : undefined;
}

/** Starts `opencode serve` and waits for the line that names its address. */
export function startOpenCodeServer(input: OpenCodeServeInput): Promise<OpenCodeServerHandle> {
  const password = randomBytes(24).toString("base64url");
  const configContent = mergedConfigContent(input.env.OPENCODE_CONFIG_CONTENT, input.config);
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    // OpenCode 2 reads OPENCODE_PASSWORD, OpenCode 1 OPENCODE_SERVER_PASSWORD.
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PASSWORD: password,
    ...(configContent ? { OPENCODE_CONFIG_CONTENT: configContent } : {}),
  };
  delete env.OPENCODE_SERVER_USERNAME;
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0", ...(input.args ?? [])];
  const invocation = commandInvocation(input.command, args, { env });
  // On Linux the server runs in its own systemd scope, so a memory kill takes it and not the host.
  const launch = (input.wrap ?? wrapAgentCommand)({ command: invocation.command, args: invocation.args, name: "opencode", env });
  const child: ChildProcess = spawn(launch.command, launch.args, {
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
      void connectOpenCodeApi({ url, password, ...(input.fetch ? { fetch: input.fetch } : {}) }).then((api) => {
        resolve({
          url,
          password,
          local: true,
          ...(mcpServerNames(input.config) ? { mcpServers: mcpServerNames(input.config)! } : {}),
          api,
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
      }, (error: unknown) => {
        stop();
        reject(new Error(`OpenCode's server did not answer: ${error instanceof Error ? error.message : String(error)}${output.trim() ? `\n${output.trim().slice(-2_000)}` : ""}`));
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
      const exitReason = () => new Error(`OpenCode's server exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}.${output.trim() ? `\n${output.trim().slice(-2_000)}` : ""}`);
      const settle = (reason: Error) => {
        if (!ready) return fail(reason);
        input.onExit?.(closedByTau ? undefined : reason);
      };
      // A memory kill is told apart only for a server Tau did not close itself.
      if (closedByTau || code === 0 || !launch.scope) return settle(exitReason());
      void launch.scope.oomKilled().catch(() => false).then((killed) => settle(killed ? new Error(AGENT_OOM_MESSAGE) : exitReason()));
    });
  });
}

/** An OpenCode server the user runs, reached by URL and password; its generation and version are checked here. */
export async function connectOpenCodeServer(url: string, password: string | undefined, fetcher?: typeof globalThis.fetch): Promise<OpenCodeServerHandle> {
  const api = await connectOpenCodeApi({ url, ...(password ? { password } : {}), ...(fetcher ? { fetch: fetcher } : {}) });
  let closed = false;
  return {
    url: url.replace(/\/+$/u, ""),
    ...(password ? { password } : {}),
    local: false,
    api,
    get closed() { return closed; },
    close: async () => { closed = true; },
  };
}
