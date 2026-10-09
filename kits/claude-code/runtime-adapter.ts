import { query as sdkQuery, type CanUseTool, type EffortLevel, type OnUserDialog, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HostMcpConnection, RuntimePermissionLevel, RuntimePromptInput, RuntimePromptResult, RuntimeTransport, SkillRuntimeAdapter } from "tau/host-extension";
import { homedir } from "node:os";
import manifest from "./tau-extension.json";
import { probeClaude, type ClaudeProbe } from "./probe.js";
import { ClaudeSdkSession } from "./sdk-session.js";
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
 * Claude's `default` mode asks before a tool runs. Without a way to put that
 * question to the user, accepting `ask` would leave a turn waiting on a
 * question nobody can see.
 */
export function assertClaudePermissionPolicySupported(policy: RuntimePermissionPolicy, options: { canAsk?: boolean } = {}): void {
  if (!policy || !["plan", "default", "auto"].includes(policy.permissionMode)) {
    throw new Error("Claude Code received an unsupported Tau permission policy.");
  }
  if (policy.permissionMode === "default" && options.canAsk === false) {
    throw new Error("Claude Code manual approvals are unsupported on this host; choose read-only or full access before launching Claude.");
  }
}

/** What a turn hands the SDK for the questions Claude asks while it runs. */
export interface ClaudeTurnHooks {
  canUseTool?: CanUseTool;
  onUserDialog?: OnUserDialog;
}

export function runtimePermissionPolicy(level: RuntimePermissionLevel): RuntimePermissionPolicy {
  return { permissionMode: PERMISSION_MODES[level] };
}

export interface ClaudeCodeAgentRuntimeAdapter extends SkillRuntimeAdapter {
  /** `claude-code`, or `claude-code@<instance>` for another instance. */
  readonly id: string;
  readonly capabilities: { readonly skillInvocationDialect: "claude-code"; readonly ownsModelSelection: false; readonly interactiveApprovals: true; readonly modes: readonly ["plan"] };
  readonly transport: RuntimeTransport;
  /** One turn with every SDK frame reported as it arrives; resolves when the turn's result is in. */
  stream(input: RuntimePromptInput, onMessage: (message: SDKMessage) => void, hooks?: ClaudeTurnHooks): Promise<RuntimePromptResult>;
  /** A live session for a thread, started; the backend feeds it turns and closes it. */
  openSession(input: ClaudeSessionInput): ClaudeSdkSession;
  /** What the CLI says about its login and models; cached for a few minutes. `usage` also reads the plan's windows, afresh. */
  probe(options?: { fresh?: boolean; usage?: boolean }): Promise<ClaudeProbe>;
  /** Shared app-data store used to resume this adapter after eviction/restart. */
  readonly sessionStore?: ClaudeRuntimeSessionStore;
}

export interface ClaudeSessionInput {
  cwd: string;
  claudeSessionId: string;
  /** Resume the session instead of creating it under `claudeSessionId`. */
  started: boolean;
  permissionLevel: RuntimePermissionLevel;
  /** The thread's chosen model and effort; the CLI's own defaults otherwise. */
  model?: string;
  effort?: EffortLevel;
  hooks?: ClaudeTurnHooks;
  /** Tau's tools for this thread, over the host's MCP endpoint. */
  mcpServer?: HostMcpConnection;
  /** The only tools the thread keeps, as Pi names them; every tool when absent. */
  tools?: readonly string[];
  /** The project holds its commands to this machine and these hosts (API 1.14.0). */
  network?: ClaudeNetworkLimit;
  onMessage(message: SDKMessage, unclaimed?: boolean): void;
  onExit(error: unknown | undefined): void;
  /** The CLI's stderr, for the message when the session fails. */
  onStderr?(chunk: string): void;
}

export interface ClaudeCodeRuntimeOptions {
  /** The CLI to run: a name on the login shell's PATH or a path; a function is asked each time. */
  command?: string | (() => string);
  /** Resolves a bare command name to its path; the name is passed through otherwise. */
  resolveCommand?(name: string): string | undefined;
  /** The SDK's `query`; tests script it. */
  query?: ClaudeQuery;
  /** Where the adapter persists what it needs to resume; the host half derives it from `services.sessionsDir`. */
  storePath: string;
  /** Environment for the CLI; the host's own by default. */
  env?: NodeJS.ProcessEnv;
  /** The backend kind the adapter serves; `claude-code` by default. */
  id?: string;
  /** The store every instance shares; one of its own at `storePath` otherwise. */
  sessionStore?: ClaudeRuntimeSessionStore;
  /** The instance's own options for every launch, as the SDK takes them. */
  extraArgs?: Record<string, string | null>;
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
  hooks?: ClaudeTurnHooks;
  model?: string;
  effort?: EffortLevel;
  mcpServer?: HostMcpConnection;
  tools?: readonly string[];
  network?: ClaudeNetworkLimit;
  extraArgs?: Record<string, string | null>;
}

/** A project's network limit as the Agent SDK runtime applies it. */
export interface ClaudeNetworkLimit {
  allowHosts: readonly string[];
}

/**
 * The SDK's own sandbox around every Bash command: loopback and the allowed
 * hosts only, never a command outside it, and still a question per command at
 * the ask level. Files stay as open as without it. WebFetch runs in the CLI's
 * own process, outside any sandbox, so it is switched off.
 */
export function claudeNetworkOptions(limit: ClaudeNetworkLimit): Pick<Options, "sandbox" | "disallowedTools"> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...limit.allowHosts], strictAllowlist: true, allowLocalBinding: true, allowAllUnixSockets: true },
      filesystem: { disabled: true },
    },
    disallowedTools: ["WebFetch"],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Everything one `query()` call is told. The user's own `claude` runs with the
 * user's own settings; Tau adds only its client identity.
 */
export function claudeQueryOptions(plan: ClaudeQueryPlan): Options {
  assertClaudePermissionPolicySupported(plan.policy, { canAsk: plan.hooks?.canUseTool !== undefined });
  if (!UUID.test(plan.claudeSessionId)) throw new Error("Claude session ids must be UUIDs.");
  return {
    ...(plan.hooks?.canUseTool ? { canUseTool: plan.hooks.canUseTool } : {}),
    // The resume-compaction question is the one dialog the workbench answers; others are declined.
    ...(plan.hooks?.onUserDialog ? { onUserDialog: plan.hooks.onUserDialog, supportedDialogKinds: ["resume_return"] } : {}),
    cwd: plan.cwd,
    pathToClaudeCodeExecutable: plan.executable,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    permissionMode: plan.policy.permissionMode,
    ...(plan.model ? { model: plan.model } : {}),
    ...(plan.effort ? { effort: plan.effort } : {}),
    // Token deltas arrive as stream events; the whole message still follows.
    includePartialMessages: true,
    ...(plan.started ? { resume: plan.claudeSessionId } : { sessionId: plan.claudeSessionId }),
    env: { ...plan.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
    abortController: plan.abortController,
    ...(plan.stderr ? { stderr: plan.stderr } : {}),
    ...(plan.mcpServer ? tauMcpOptions(plan.mcpServer) : {}),
    ...(plan.tools ? claudeToolOptions(plan.tools) : {}),
    ...(plan.network ? claudeNetworkOptions(plan.network) : {}),
    ...(plan.extraArgs && Object.keys(plan.extraArgs).length ? { extraArgs: { ...plan.extraArgs } } : {}),
  };
}

/**
 * An instance's launch arguments as the SDK's `extraArgs`: long options only,
 * `--flag`, `--key value` or `--key=value`. Anything else is a problem the
 * Providers card reports rather than an argument silently dropped.
 */
export function sdkExtraArgs(args: readonly string[]): { extraArgs: Record<string, string | null>; problem?: string } {
  const extraArgs: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!/^--[A-Za-z0-9][A-Za-z0-9-]*(?:=.*)?$/u.test(arg)) return { extraArgs, problem: `“${arg}” is not a long option; the Agent SDK passes only --name or --name value.` };
    const equals = arg.indexOf("=");
    if (equals > 0) {
      extraArgs[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      extraArgs[arg.slice(2)] = next;
      index += 1;
    } else {
      extraArgs[arg.slice(2)] = null;
    }
  }
  return { extraArgs };
}

/** Pi's names for the tools Claude has under its own. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
};

/**
 * A thread restricted to some tools: Claude's own by their Pi names or its
 * own (`WebFetch`), nothing else built in, and no MCP server but Tau's, whose
 * endpoint filters Tau's tools. A name Claude does not have is dropped, as on Pi.
 */
export function claudeToolOptions(tools: readonly string[]): Pick<Options, "tools" | "strictMcpConfig"> {
  const own = tools.flatMap((tool) => CLAUDE_TOOL_NAMES[tool] ?? (/^[A-Z][A-Za-z]*$/u.test(tool) ? [tool] : []));
  return { tools: [...new Set(own)], strictMcpConfig: true };
}

/**
 * Tau's tools as one more MCP server beside the user's own. Its tools are
 * pre-approved here because Tau's own gate asks for them, as it does for Pi;
 * a second question from Claude would only repeat the first.
 */
export function tauMcpOptions(server: HostMcpConnection): Pick<Options, "mcpServers" | "allowedTools"> {
  return {
    mcpServers: { [server.name]: { type: "http", url: server.url, headers: { ...server.headers } } },
    allowedTools: [`mcp__${server.name}`],
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
 * `onMessage` sees every frame first, in order.
 */
export async function consumeTurn(messages: AsyncIterable<SDKMessage>, onMessage?: (message: SDKMessage) => void): Promise<string> {
  const texts: string[] = [];
  let sawAssistant = false;
  for await (const message of messages) {
    onMessage?.(message);
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

export const collectTurnText = (messages: AsyncIterable<SDKMessage>): Promise<string> => consumeTurn(messages);

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
  const commandName = (): string => (typeof options.command === "function" ? options.command() : options.command) ?? process.env.TAU_CLAUDE_CODE_COMMAND ?? "claude";
  const query = options.query ?? sdkQuery;
  const env = options.env ?? process.env;
  const sessionStore = options.sessionStore ?? new ClaudeRuntimeSessionStore({ filePath: options.storePath });
  const running = new Map<string, Set<RunningTurn>>();
  const requestQueues = new Map<string, Promise<void>>();
  const abortGenerations = new Map<string, number>();
  // The composer offers Claude's models and efforts; its questions reach the workbench through the turn's hooks.
  const capabilities = { skillInvocationDialect: "claude-code", ownsModelSelection: false, interactiveApprovals: true, modes: ["plan"] } as const;
  const PROBE_TTL_MS = 5 * 60_000;
  let probeCache: { at: number; result: Promise<ClaudeProbe> } | undefined;

  function probe(probeOptions: { fresh?: boolean; usage?: boolean } = {}): Promise<ClaudeProbe> {
    const now = Date.now();
    if (!probeOptions.fresh && !probeOptions.usage && probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.result;
    const result = probeClaude({ query, executable: options.resolveCommand?.(commandName()) ?? commandName(), cwd: homedir(), env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP }, ...(probeOptions.usage ? { usage: true } : {}) });
    probeCache = { at: now, result };
    // A failed probe is not remembered; the next caller tries again.
    result.catch(() => { if (probeCache?.result === result) probeCache = undefined; });
    return result;
  }

  async function runTurn(input: RuntimePromptInput, claudeSessionId: string, started: boolean, policy: RuntimePermissionPolicy, onMessage?: (message: SDKMessage) => void, hooks?: ClaudeTurnHooks): Promise<string> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    let stderr = "";
    const plan: ClaudeQueryPlan = {
      cwd: input.cwd,
      executable: options.resolveCommand?.(commandName()) ?? commandName(),
      claudeSessionId,
      started,
      policy,
      abortController: controller,
      env,
      ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
      stderr: (chunk) => { stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_BYTES); },
      ...(hooks ? { hooks } : {}),
    };
    const turn: RunningTurn = { controller, done: Promise.resolve() };
    const active = running.get(input.tauThreadId) ?? new Set<RunningTurn>();
    active.add(turn);
    running.set(input.tauThreadId, active);
    const done = (async () => {
      try {
        if (controller.signal.aborted) throw abortError("Claude Code request aborted.");
        return await consumeTurn(query({ prompt: input.text, options: claudeQueryOptions(plan) }), onMessage);
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

  async function deliver(input: RuntimePromptInput, onMessage?: (message: SDKMessage) => void, hooks?: ClaudeTurnHooks): Promise<RuntimePromptResult> {
        const policy = runtimePermissionPolicy(input.permissionLevel ?? "full");
        // Reject an unsupported Tau access mode before joining a queue or
        // spawning anything, so a queued request cannot turn into a hang.
        assertClaudePermissionPolicySupported(policy, { canAsk: hooks?.canUseTool !== undefined });
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
            return runTurn(input, record.claudeSessionId, started, policy, onMessage, hooks);
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
  }

  function openSession(input: ClaudeSessionInput): ClaudeSdkSession {
    const policy = runtimePermissionPolicy(input.permissionLevel);
    const queryOptions = claudeQueryOptions({
      cwd: input.cwd,
      executable: options.resolveCommand?.(commandName()) ?? commandName(),
      claudeSessionId: input.claudeSessionId,
      started: input.started,
      policy,
      // The session owns the controller it actually aborts with.
      abortController: new AbortController(),
      env,
      ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
      ...(input.onStderr ? { stderr: input.onStderr } : {}),
      ...(input.hooks ? { hooks: input.hooks } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.mcpServer ? { mcpServer: input.mcpServer } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.network ? { network: input.network } : {}),
    });
    const session = new ClaudeSdkSession({ query, options: queryOptions, claudeSessionId: input.claudeSessionId, onMessage: input.onMessage, onExit: input.onExit });
    session.start();
    return session;
  }

  return {
    id: options.id ?? "claude-code",
    capabilities,
    sessionStore,
    stream: (input, onMessage, hooks) => deliver(input, onMessage, hooks),
    openSession,
    probe,
    transport: {
      sendPrompt: (input) => deliver(input),
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
