import { spawn, type ChildProcess } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AccessLevel, RuntimeCapabilities } from "../shared/contracts.js";
import { PI_RUNTIME_ADAPTER, type SkillRuntimeAdapter } from "./skill-invocation.js";
import { ClaudeRuntimeSessionStore } from "./claude-runtime-store.js";

export interface RuntimePermissionPolicy {
  /** Claude's supported mode corresponding to Tau's access setting. */
  permissionMode: "plan" | "manual" | "auto";
  /** Explicit Claude tool allow-list. `default` delegates the normal set. */
  tools: readonly string[];
}

const CLAUDE_POLICIES: Record<AccessLevel, RuntimePermissionPolicy> = {
  "read-only": { permissionMode: "plan", tools: ["Read", "Glob", "Grep"] },
  ask: { permissionMode: "manual", tools: ["default"] },
  full: { permissionMode: "auto", tools: ["default"] },
};

export function runtimePermissionPolicy(level: AccessLevel): RuntimePermissionPolicy {
  const policy = CLAUDE_POLICIES[level];
  return { permissionMode: policy.permissionMode, tools: [...policy.tools] };
}

export interface RuntimePromptInput {
  cwd: string;
  sessionId: string;
  text: string;
  delivery?: "prompt" | "steer" | "followUp";
  clientMessageId?: string;
  permissionPolicy?: RuntimePermissionPolicy;
  signal?: AbortSignal;
}

export interface RuntimePromptResult {
  assistantText?: string;
}

export interface RuntimeTransport {
  sendPrompt(input: RuntimePromptInput): Promise<RuntimePromptResult>;
  /** Stops children owned by one Tau session; absent only on test transports. */
  abort?(sessionId: string): Promise<void>;
}

export interface PiAgentRuntimeAdapter extends SkillRuntimeAdapter {
  readonly id: "pi";
  readonly capabilities: { readonly skillInvocationDialect: "pi" };
  readonly transport?: never;
}

export interface ClaudeCodeAgentRuntimeAdapter extends SkillRuntimeAdapter {
  readonly id: "claude-code";
  readonly capabilities: { readonly skillInvocationDialect: "claude-code" };
  readonly transport: RuntimeTransport;
  /** Shared app-data store used to resume this adapter after eviction/restart. */
  readonly sessionStore?: ClaudeRuntimeSessionStore;
}

export type AgentRuntimeAdapter = PiAgentRuntimeAdapter | ClaudeCodeAgentRuntimeAdapter;

/** Rejects an adapter whose declared dialect does not belong to its transport. */
export function assertRuntimeAdapter(adapter: unknown): AgentRuntimeAdapter {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("A runtime adapter configuration is required.");
  }
  const candidate = adapter as {
    id?: unknown;
    capabilities?: RuntimeCapabilities;
    transport?: RuntimeTransport;
  };
  if (candidate.id !== "pi" && candidate.id !== "claude-code") {
    throw new Error(`Unsupported runtime adapter '${String(candidate.id)}'.`);
  }
  const expectedDialect = candidate.id === "claude-code" ? "claude-code" : "pi";
  if (candidate.capabilities?.skillInvocationDialect !== expectedDialect) {
    throw new Error(`Runtime adapter '${candidate.id}' must declare the '${expectedDialect}' invocation dialect.`);
  }
  if (candidate.id === "pi" && candidate.transport !== undefined) {
    throw new Error("The Pi runtime adapter must not define a second transport.");
  }
  if (candidate.id === "claude-code" && (!candidate.transport || typeof candidate.transport.sendPrompt !== "function")) {
    throw new Error("The Claude Code runtime adapter requires a configured transport.");
  }
  return adapter as AgentRuntimeAdapter;
}

export const PI_AGENT_RUNTIME_ADAPTER: PiAgentRuntimeAdapter = {
  id: "pi",
  capabilities: PI_RUNTIME_ADAPTER.capabilities,
};

export interface ClaudeCodeRuntimeOptions {
  command?: string;
  maxBuffer?: number;
  timeoutMs?: number;
  killGraceMs?: number;
  store?: ClaudeRuntimeSessionStore;
  storePath?: string;
  agentDir?: string;
}

interface RunningChild {
  child: ChildProcess;
  terminate(reason: Error): Promise<void>;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function childClosed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* the child exited between the check and kill */ }
  await Promise.race([
    childClosed(child),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref?.()),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGKILL"); } catch { /* the child exited between the check and kill */ }
  await Promise.race([
    childClosed(child),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref?.()),
  ]);
}

async function waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, timeoutMs)).unref?.()),
  ]);
}

/** Builds the complete Claude command line; the prompt is always after `--`. */
export function claudeCodeArgs(
  claudeSessionId: string,
  started: boolean,
  prompt: string,
  policy: RuntimePermissionPolicy,
): string[] {
  return [
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    policy.permissionMode,
    "--tools",
    policy.tools.join(","),
    ...(started ? ["--resume", claudeSessionId] : ["--session-id", claudeSessionId]),
    "--",
    prompt,
  ];
}

function runClaudeProcess(
  command: string,
  args: readonly string[],
  input: RuntimePromptInput,
  maxBuffer: number,
  timeoutMs: number,
  killGraceMs: number,
  activeProcesses: Map<string, Set<RunningChild>>,
): Promise<string> {
  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return Promise.reject(error);
  }

  let settled = false;
  let terminating: Error | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stdout = "";
  let stderr = "";
  let terminateProcess: (reason: Error) => Promise<void> = async () => undefined;
  let resolveResult!: (value: string) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const running: RunningChild = {
    child,
    terminate: async (reason) => {
      if (settled || terminating) return;
      terminating = reason;
      await terminateChild(child, killGraceMs);
      settle(reason);
    },
  };
  terminateProcess = running.terminate;
  const active = activeProcesses.get(input.sessionId) ?? new Set<RunningChild>();
  active.add(running);
  activeProcesses.set(input.sessionId, active);

  const cleanup = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
    active.delete(running);
    if (active.size === 0) activeProcesses.delete(input.sessionId);
  };
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectResult(error);
    else resolveResult(stdout);
  };
  const onAbort = () => { void terminateProcess(abortError("Claude Code request aborted.")); };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (settled || terminating) return;
    stdout += chunk;
    if (Buffer.byteLength(stdout, "utf8") > maxBuffer) {
      void terminateProcess(new Error(`Claude Code output exceeded the ${maxBuffer}-byte limit.`));
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    if (!settled) stderr += chunk;
  });
  child.once("error", (error) => {
    if (terminating) settle(terminating);
    else settle(error);
  });
  child.once("close", (code, signal) => {
    if (terminating) {
      settle(terminating);
      return;
    }
    if (code === 0) {
      settle();
      return;
    }
    const detail = stderr.trim() || `exit code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`;
    settle(new Error(`Claude Code exited unsuccessfully: ${detail}`));
  });
  timeout = setTimeout(() => {
    void terminateProcess(abortError(`Claude Code request timed out after ${timeoutMs} ms.`));
  }, timeoutMs);
  timeout.unref?.();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  return result;
}

/**
 * Production Claude Code transport. It owns every child process and never
 * hands Claude's slash dialect to the embedded Pi session.
 */
export function createClaudeCodeRuntimeAdapter(options: ClaudeCodeRuntimeOptions = {}): ClaudeCodeAgentRuntimeAdapter {
  const command = options.command ?? process.env.TAU_CLAUDE_CODE_COMMAND ?? "claude";
  const maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const killGraceMs = options.killGraceMs ?? 500;
  const sessionStore = options.store ?? new ClaudeRuntimeSessionStore({
    filePath: options.storePath ?? ClaudeRuntimeSessionStore.defaultPath(options.agentDir ?? getAgentDir()),
  });
  const activeProcesses = new Map<string, Set<RunningChild>>();
  const requestQueues = new Map<string, Promise<void>>();
  const abortGenerations = new Map<string, number>();
  const capabilities = { skillInvocationDialect: "claude-code" } as const;
  return {
    id: "claude-code",
    capabilities,
    sessionStore,
    transport: {
      async sendPrompt(input) {
        const generation = abortGenerations.get(input.sessionId) ?? 0;
        const previous = requestQueues.get(input.sessionId) ?? Promise.resolve();
        const operation = previous.then(async () => {
          if (generation !== (abortGenerations.get(input.sessionId) ?? 0) || input.signal?.aborted) {
            throw abortError("Claude Code request aborted.");
          }
          const record = await sessionStore.ensure(input.sessionId, input.cwd);
          if (generation !== (abortGenerations.get(input.sessionId) ?? 0) || input.signal?.aborted) {
            throw abortError("Claude Code request aborted.");
          }
          const policy = input.permissionPolicy ?? runtimePermissionPolicy("full");
          const args = claudeCodeArgs(record.claudeSessionId, record.started, input.text, policy);
          const assistantText = await runClaudeProcess(
            command,
            args,
            input,
            maxBuffer,
            timeoutMs,
            killGraceMs,
            activeProcesses,
          );
          await sessionStore.markStarted(input.sessionId, input.cwd);
          return { assistantText };
        });
        const settled = operation.then(() => undefined, () => undefined);
        requestQueues.set(input.sessionId, settled);
        try {
          return await operation;
        } finally {
          if (requestQueues.get(input.sessionId) === settled) requestQueues.delete(input.sessionId);
        }
      },
      async abort(sessionId) {
        abortGenerations.set(sessionId, (abortGenerations.get(sessionId) ?? 0) + 1);
        const children = [...(activeProcesses.get(sessionId) ?? [])];
        await Promise.all(children.map((running) => running.terminate(abortError("Claude Code request aborted."))));
        const queued = requestQueues.get(sessionId);
        if (queued) await waitBounded(queued, Math.max(killGraceMs * 2, 100));
      },
    },
  };
}

/** Selects the actual agent transport once during host startup. */
export function selectRuntimeAdapter(
  value: string | undefined = process.env.TAU_RUNTIME_ADAPTER,
  options: { safeMode?: boolean } = {},
): AgentRuntimeAdapter {
  // Safe mode is a hard runtime boundary. An environment value cannot opt it
  // back into a process that bypasses Tau's extension-free startup contract.
  if (options.safeMode) return PI_AGENT_RUNTIME_ADAPTER;
  switch (value?.trim().toLowerCase() || "pi") {
    case "pi":
      return PI_AGENT_RUNTIME_ADAPTER;
    case "claude-code":
      return createClaudeCodeRuntimeAdapter();
    default:
      throw new Error(`Unsupported TAU_RUNTIME_ADAPTER '${value}'. Use 'pi' or 'claude-code'.`);
  }
}
