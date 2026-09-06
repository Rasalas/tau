import { spawn, type ChildProcess } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillRuntimeAdapter } from "../../skill-invocation.js";
import type { RuntimePermissionLevel, RuntimePromptInput, RuntimeTransport } from "../../runtime-adapters.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";

export interface RuntimePermissionPolicy {
  /** Claude's supported mode corresponding to Tau's access setting. */
  permissionMode: "plan" | "manual" | "auto";
  /** Explicit Claude tool allow-list; installation defaults are never used. */
  tools: readonly string[];
}

const CLAUDE_POLICIES: Record<RuntimePermissionLevel, RuntimePermissionPolicy> = {
  "read-only": { permissionMode: "plan", tools: ["Read", "Glob", "Grep"] },
  // Keep the CLI's tool surface explicit. `default` would make the adapter's
  // behavior depend on a user's Claude installation and can expose tools that
  // Tau did not make available.
  ask: { permissionMode: "manual", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] },
  full: { permissionMode: "auto", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] },
};

/**
 * Claude's `manual` permission mode needs an interactive TTY approval prompt.
 * Tau invokes Claude through `--print`, so accepting that mode would leave a
 * child waiting forever with no way for the user to answer it.
 */
export function assertClaudePermissionPolicySupported(policy: RuntimePermissionPolicy): void {
  if (!policy || !["plan", "manual", "auto"].includes(policy.permissionMode)) {
    throw new Error("Claude Code received an unsupported Tau permission policy.");
  }
  if (policy.permissionMode === "manual") {
    throw new Error("Claude Code manual approvals are unsupported in non-interactive --print mode; choose read-only or full access before launching Claude.");
  }
  if (!Array.isArray(policy.tools)) throw new Error("Claude Code received an unsupported Tau tool policy.");
  const expected = CLAUDE_POLICIES[policy.permissionMode === "plan" ? "read-only" : "full"];
  if (policy.tools.length !== expected.tools.length || policy.tools.some((tool, index) => tool !== expected.tools[index])) {
    throw new Error("Claude Code received an unsupported Tau tool policy.");
  }
}

export function runtimePermissionPolicy(level: RuntimePermissionLevel): RuntimePermissionPolicy {
  const policy = CLAUDE_POLICIES[level];
  return { permissionMode: policy.permissionMode, tools: [...policy.tools] };
}

export interface ClaudeCodeAgentRuntimeAdapter extends SkillRuntimeAdapter {
  readonly id: "claude-code";
  readonly capabilities: { readonly skillInvocationDialect: "claude-code"; readonly ownsModelSelection: true; readonly interactiveApprovals: false };
  readonly transport: RuntimeTransport;
  /** Shared app-data store used to resume this adapter after eviction/restart. */
  readonly sessionStore?: ClaudeRuntimeSessionStore;
}

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
  assertClaudePermissionPolicySupported(policy);
  return [
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    policy.permissionMode,
    "--tools",
    policy.tools.join(","),
    "--allowed-tools",
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
  tauThreadId: string,
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
  let stdoutTruncated = false;
  let stderr = "";
  let stderrTruncated = false;
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
  const active = activeProcesses.get(tauThreadId) ?? new Set<RunningChild>();
  active.add(running);
  activeProcesses.set(tauThreadId, active);

  const cleanup = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
    active.delete(running);
    if (active.size === 0) activeProcesses.delete(tauThreadId);
  };
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectResult(error);
    else resolveResult(stdout);
  };
  const onAbort = () => { void terminateProcess(abortError("Claude Code request aborted.")); };

  const appendStderr = (chunk: string): void => {
    if (stderrTruncated) return;
    const next = `${stderr}${chunk}`;
    if (Buffer.byteLength(next, "utf8") <= maxBuffer) {
      stderr = next;
      return;
    }
    const marker = "\n[Claude Code stderr truncated]\n";
    stderr = boundedOutputWithMarker(next, marker, maxBuffer);
    stderrTruncated = true;
  };

  const appendStdout = (chunk: string): void => {
    if (stdoutTruncated) return;
    const next = `${stdout}${chunk}`;
    if (Buffer.byteLength(next, "utf8") <= maxBuffer) {
      stdout = next;
      return;
    }
    const marker = "\n[Claude Code stdout truncated]\n";
    stdout = boundedOutputWithMarker(next, marker, maxBuffer);
    stdoutTruncated = true;
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (settled || terminating) return;
    appendStdout(chunk);
    if (stdoutTruncated) {
      void terminateProcess(new Error(`Claude Code stdout exceeded the ${maxBuffer}-byte limit.\n[Claude Code stdout truncated]`));
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    if (settled || terminating) return;
    appendStderr(chunk);
    if (stderrTruncated) {
      void terminateProcess(new Error(`Claude Code stderr exceeded the ${maxBuffer}-byte limit.\n[Claude Code stderr truncated]`));
    }
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
  // Claude picks its model and cannot stop for an approval in print mode.
  const capabilities = { skillInvocationDialect: "claude-code", ownsModelSelection: true, interactiveApprovals: false } as const;
  return {
    id: "claude-code",
    capabilities,
    sessionStore,
    transport: {
      async sendPrompt(input) {
        const policy = runtimePermissionPolicy(input.permissionLevel ?? "full");
        // Reject an unsupported Tau access mode before joining a queue or
        // spawning anything, so a queued request cannot turn into a hang.
        assertClaudePermissionPolicySupported(policy);
        const generation = abortGenerations.get(input.tauThreadId) ?? 0;
        const previous = requestQueues.get(input.tauThreadId) ?? Promise.resolve();
        const operation = previous.then(async () => {
          if (generation !== (abortGenerations.get(input.tauThreadId) ?? 0) || input.signal?.aborted) {
            throw abortError("Claude Code request aborted.");
          }
          const record = await sessionStore.ensure(input.tauThreadId, input.cwd);
          if (generation !== (abortGenerations.get(input.tauThreadId) ?? 0) || input.signal?.aborted) {
            throw abortError("Claude Code request aborted.");
          }
          // `attempted` is persisted before spawning. On the next request a
          // previously attempted-but-unconfirmed id is resumed first; only a
          // clear "missing session" response permits one create fallback.
          const resumeFirst = record.started || record.attempted;
          const run = async (started: boolean): Promise<string> => {
            await sessionStore.markAttempted(input.tauThreadId, input.cwd);
            if (generation !== (abortGenerations.get(input.tauThreadId) ?? 0) || input.signal?.aborted) {
              throw abortError("Claude Code request aborted.");
            }
            return runClaudeProcess(
              command,
              claudeCodeArgs(record.claudeSessionId, started, input.text, policy),
              input,
              maxBuffer,
              timeoutMs,
              killGraceMs,
              input.tauThreadId,
              activeProcesses,
            );
          };
          let assistantText: string;
          try {
            assistantText = await run(resumeFirst);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const aborted = error instanceof Error && error.name === "AbortError";
            if (aborted) {
              await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "aborted");
              throw error;
            }
            // A first create can race an already-created Claude session. A
            // later resume is the safe recovery; a failed resume can likewise
            // fall back to create exactly once when Claude says the id is gone.
            const missing = /(?:session|conversation)[^\n]*(?:not found|does not exist|unknown|missing|invalid)|(?:no|cannot|could not)\s+(?:find\s+)?(?:the\s+)?(?:session|conversation)/iu.test(message);
            const conflict = /(?:session|conversation)[^\n]*(?:already exists|already in use|conflict)/iu.test(message);
            if (resumeFirst && !record.createFallbackUsed && missing) {
              await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "missing");
              await sessionStore.markCreateFallbackUsed(input.tauThreadId, input.cwd);
              try {
                assistantText = await run(false);
              } catch (fallbackError) {
                await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "failed");
                throw fallbackError;
              }
            } else if (!resumeFirst && conflict) {
              await sessionStore.markCreateFallbackUsed(input.tauThreadId, input.cwd);
              try {
                assistantText = await run(true);
              } catch (fallbackError) {
                await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "failed");
                throw fallbackError;
              }
            } else {
              await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "failed");
              throw error;
            }
          }
          if (generation !== (abortGenerations.get(input.tauThreadId) ?? 0) || input.signal?.aborted) {
            await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "aborted");
            throw abortError("Claude Code request aborted.");
          }
          await sessionStore.markStarted(input.tauThreadId, input.cwd);
          return { assistantText };
        });
        const settled = operation.then(() => undefined, () => undefined);
        requestQueues.set(input.tauThreadId, settled);
        try {
          return await operation;
        } finally {
          if (requestQueues.get(input.tauThreadId) === settled) requestQueues.delete(input.tauThreadId);
        }
      },
      async abort(tauThreadId) {
        abortGenerations.set(tauThreadId, (abortGenerations.get(tauThreadId) ?? 0) + 1);
        const children = [...(activeProcesses.get(tauThreadId) ?? [])];
        await Promise.all(children.map((running) => running.terminate(abortError("Claude Code request aborted."))));
        const queued = requestQueues.get(tauThreadId);
        if (queued) await waitBounded(queued, Math.max(killGraceMs * 2, 100));
      },
    },
  };
}

/** Keep captured provider output bounded even when the configured limit is tiny. */
function boundedOutputWithMarker(value: string, marker: string, maxBytes: number): string {
  const limit = Math.max(0, maxBytes);
  if (limit === 0) return "";
  const markerBytes = Buffer.from(marker, "utf8");
  if (markerBytes.length >= limit) return markerBytes.subarray(0, limit).toString("utf8");
  const prefix = utf8Prefix(value, limit - markerBytes.length);
  return prefix + marker;
}

/** Keep a truncated UTF-8 prefix valid as well as bounded in bytes. */
function utf8Prefix(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (limit === 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  let prefix = bytes.subarray(0, limit).toString("utf8");
  // Buffer#toString replaces a cut-off code point with U+FFFD, which is
  // three bytes and could exceed a one- or two-byte budget after re-encoding.
  while (Buffer.byteLength(prefix, "utf8") > limit) prefix = prefix.slice(0, -1);
  return prefix;
}
