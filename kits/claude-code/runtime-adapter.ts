import { query as sdkQuery, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimePermissionLevel, RuntimePromptInput, RuntimeTransport, SkillRuntimeAdapter } from "tau/host-extension";
import manifest from "./tau-extension.json";
import { ClaudeRuntimeSessionStore } from "./session-store.js";

/** The SDK entry the adapter drives; tests inject a scripted one. */
export type ClaudeQuery = typeof sdkQuery;

export interface RuntimePermissionPolicy {
  /** Claude's permission mode corresponding to Tau's access level. */
  permissionMode: "plan" | "default" | "auto";
}

const PERMISSION_MODES: Record<RuntimePermissionLevel, RuntimePermissionPolicy["permissionMode"]> = {
  "read-only": "plan",
  ask: "default",
  full: "auto",
};

/** Identifies Tau to the SDK; never Claude Code's own headers or prompt. */
export const CLIENT_APP = `${manifest.id}/${manifest.version}`;

/**
 * Claude's `default` mode asks before a tool runs. Until the backend answers
 * those prompts through the workbench, accepting `ask` would leave a turn
 * waiting on a question nobody can see.
 */
export function assertClaudePermissionPolicySupported(policy: RuntimePermissionPolicy): void {
  if (!policy || !["plan", "default", "auto"].includes(policy.permissionMode)) {
    throw new Error("Claude Code received an unsupported Tau permission policy.");
  }
  if (policy.permissionMode === "default") {
    throw new Error("Claude Code manual approvals are unsupported by this backend yet; choose read-only or full access before launching Claude.");
  }
}

export function runtimePermissionPolicy(level: RuntimePermissionLevel): RuntimePermissionPolicy {
  return { permissionMode: PERMISSION_MODES[level] };
}

export interface ClaudeCodeAgentRuntimeAdapter extends SkillRuntimeAdapter {
  readonly id: "claude-code";
  readonly capabilities: { readonly skillInvocationDialect: "claude-code"; readonly ownsModelSelection: true; readonly interactiveApprovals: false };
  readonly transport: RuntimeTransport;
  /** Shared app-data store used to resume this adapter after eviction/restart. */
  readonly sessionStore?: ClaudeRuntimeSessionStore;
}

export interface ClaudeCodeRuntimeOptions {
  /** The CLI to run: a name on the login shell's PATH or a path. */
  command?: string;
  /** Resolves a bare command name to its path; the name is passed through otherwise. */
  resolveCommand?(name: string): string | undefined;
  /** The SDK's `query`; tests script it. */
  query?: ClaudeQuery;
  /** Where the adapter persists what it needs to resume; the host half derives it from `services.sessionsDir`. */
  storePath: string;
  /** Environment for the CLI; the host's own by default. */
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeQueryPlan {
  cwd: string;
  executable: string;
  claudeSessionId: string;
  /** Resume the session instead of creating it under `claudeSessionId`. */
  started: boolean;
  policy: RuntimePermissionPolicy;
  abortController: AbortController;
  env: NodeJS.ProcessEnv;
  stderr?(chunk: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Everything one `query()` call is told. The user's own `claude` runs with the
 * user's own settings; Tau adds only its client identity.
 */
export function claudeQueryOptions(plan: ClaudeQueryPlan): Options {
  assertClaudePermissionPolicySupported(plan.policy);
  if (!UUID.test(plan.claudeSessionId)) throw new Error("Claude session ids must be UUIDs.");
  return {
    cwd: plan.cwd,
    pathToClaudeCodeExecutable: plan.executable,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    permissionMode: plan.policy.permissionMode,
    ...(plan.started ? { resume: plan.claudeSessionId } : { sessionId: plan.claudeSessionId }),
    env: { ...plan.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
    abortController: plan.abortController,
    ...(plan.stderr ? { stderr: plan.stderr } : {}),
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/iu.test(error.message));
}

function resultErrorText(message: SDKMessage & { type: "result" }): string {
  const candidate = message as { subtype: string; result?: unknown; errors?: unknown };
  const parts = [
    ...(Array.isArray(candidate.errors) ? candidate.errors.map(String) : []),
    typeof candidate.result === "string" ? candidate.result : "",
  ].map((part) => part.trim()).filter(Boolean);
  return parts.join("\n") || candidate.subtype;
}

/**
 * Runs one turn to its `result` and returns the assistant text of the main
 * loop: every text block Claude wrote between tool calls, not only the last.
 * Sub-agent frames carry `parent_tool_use_id` and stay out of the reply.
 */
export async function collectTurnText(messages: AsyncIterable<SDKMessage>): Promise<string> {
  const texts: string[] = [];
  let sawAssistant = false;
  for await (const message of messages) {
    if (message.type === "assistant") {
      if (message.parent_tool_use_id) continue;
      sawAssistant = true;
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text);
      }
      continue;
    }
    if (message.type !== "result") continue;
    if (message.subtype !== "success" || message.is_error) throw new Error(`Claude Code reported an error: ${resultErrorText(message)}`);
    // A resumed session answers with an empty result before the turn; the
    // real one follows.
    if (message.num_turns === 0 && !sawAssistant) continue;
    return texts.length > 0 ? texts.join("\n\n") : message.result;
  }
  throw new Error("Claude Code ended without a result.");
}

async function waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, timeoutMs)).unref?.()),
  ]);
}

interface RunningTurn {
  controller: AbortController;
  done: Promise<unknown>;
}

/**
 * Production Claude Code transport: one `query()` per turn against the user's
 * installed CLI. It never hands Claude's slash dialect to the embedded Pi
 * session.
 */
export function createClaudeCodeRuntimeAdapter(options: ClaudeCodeRuntimeOptions): ClaudeCodeAgentRuntimeAdapter {
  const command = options.command ?? process.env.TAU_CLAUDE_CODE_COMMAND ?? "claude";
  const query = options.query ?? sdkQuery;
  const env = options.env ?? process.env;
  const sessionStore = new ClaudeRuntimeSessionStore({ filePath: options.storePath });
  const running = new Map<string, Set<RunningTurn>>();
  const requestQueues = new Map<string, Promise<void>>();
  const abortGenerations = new Map<string, number>();
  // Claude picks its model; approvals wait for the workbench route.
  const capabilities = { skillInvocationDialect: "claude-code", ownsModelSelection: true, interactiveApprovals: false } as const;

  async function runTurn(input: RuntimePromptInput, claudeSessionId: string, started: boolean, policy: RuntimePermissionPolicy): Promise<string> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    let stderr = "";
    const plan: ClaudeQueryPlan = {
      cwd: input.cwd,
      executable: options.resolveCommand?.(command) ?? command,
      claudeSessionId,
      started,
      policy,
      abortController: controller,
      env,
      stderr: (chunk) => { stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_BYTES); },
    };
    const turn: RunningTurn = { controller, done: Promise.resolve() };
    const active = running.get(input.tauThreadId) ?? new Set<RunningTurn>();
    active.add(turn);
    running.set(input.tauThreadId, active);
    const done = (async () => {
      try {
        if (controller.signal.aborted) throw abortError("Claude Code request aborted.");
        return await collectTurnText(query({ prompt: input.text, options: claudeQueryOptions(plan) }));
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) throw abortError("Claude Code request aborted.");
        const detail = stderr.trim();
        if (error instanceof Error && detail && !error.message.includes(detail)) error.message = `${error.message}\n${detail}`;
        throw error;
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        active.delete(turn);
        if (active.size === 0) running.delete(input.tauThreadId);
      }
    })();
    turn.done = done.then(() => undefined, () => undefined);
    return done;
  }

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
        const stale = () => generation !== (abortGenerations.get(input.tauThreadId) ?? 0) || input.signal?.aborted === true;
        const previous = requestQueues.get(input.tauThreadId) ?? Promise.resolve();
        const operation = previous.then(async () => {
          if (stale()) throw abortError("Claude Code request aborted.");
          const record = await sessionStore.ensure(input.tauThreadId, input.cwd);
          if (stale()) throw abortError("Claude Code request aborted.");
          // `attempted` is persisted before spawning. On the next request a
          // previously attempted-but-unconfirmed id is resumed first; only a
          // clear "missing session" response permits one create fallback.
          const resumeFirst = record.started || record.attempted;
          const run = async (started: boolean): Promise<string> => {
            await sessionStore.markAttempted(input.tauThreadId, input.cwd);
            if (stale()) throw abortError("Claude Code request aborted.");
            return runTurn(input, record.claudeSessionId, started, policy);
          };
          let assistantText: string;
          try {
            assistantText = await run(resumeFirst);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isAbortError(error)) {
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
          if (stale()) {
            await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "aborted");
            throw abortError("Claude Code request aborted.");
          }
          await sessionStore.markStarted(input.tauThreadId, input.cwd);
          // `markStarted` is a one-time flip; every later turn records its own outcome.
          await sessionStore.markAttemptOutcome(input.tauThreadId, input.cwd, "started");
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
        const turns = [...(running.get(tauThreadId) ?? [])];
        for (const turn of turns) turn.controller.abort();
        await Promise.all(turns.map((turn) => waitBounded(turn.done, 5_000)));
        const queued = requestQueues.get(tauThreadId);
        if (queued) await waitBounded(queued, 1_000);
      },
    },
  };
}
