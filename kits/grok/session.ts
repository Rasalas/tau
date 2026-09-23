import { randomUUID } from "node:crypto";
import { AcpRequestError, spawnAcpProcess, type AcpExitedError, type AcpProcess, type AcpSpawnInput } from "../_acp/client.js";
import type { AcpPromptResponse, AcpSessionUpdate } from "../_acp/events.js";
import type { AcpMcpServer } from "../_acp/mcp.js";
import { AcpAgentSession, type AcpAgentSessionOptions, type AcpContentBlock, type AcpElicitationAnswer, type AcpElicitationRequest, type AcpInitializeResult, type AcpPermissionRequest, type AcpPermissionResponse } from "../_acp/session.js";
import { grokAuthMethod } from "./cli.js";

/**
 * The Grok CLI's ACP server (`grok agent stdio`): the shared session plus
 * xAI's completion signal. Grok may answer a prompt only through
 * `_x.ai/session/prompt_complete`, so each prompt carries an id and whichever
 * answer comes first ends it. The agent edits files itself; Tau offers no
 * file access, and permissions come as requests.
 */
export const PROMPT_COMPLETE = "_x.ai/session/prompt_complete";
export const SIGN_IN_HINT = "Grok is not signed in. Run `grok login` in a terminal, then try again.";
export const USAGE_LIMIT_MESSAGE = "Grok usage limit reached. Try again later.";
/** xAI's error code for an exhausted plan. */
const RATE_LIMITED = -32003;
const STOP_REASONS = new Set(["cancelled", "end_turn", "max_tokens", "max_turn_requests", "refusal"]);
const COMPLETED_IDS = 128;

interface PromptComplete { sessionId?: unknown; promptId?: unknown; stopReason?: unknown; agentResult?: unknown }

function agentResultMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const message = value && typeof value === "object" ? (value as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

export class GrokSession extends AcpAgentSession {
  private readonly pending = new Map<string, { resolve(response: AcpPromptResponse): void; reject(error: Error): void }>();
  private readonly completed: string[] = [];

  constructor(options: AcpAgentSessionOptions) {
    const self: { session?: GrokSession } = {};
    super({
      ...options,
      onNotification: (method, params) => {
        if (method === PROMPT_COMPLETE && self.session) self.session.promptComplete(params as PromptComplete);
        else options.onNotification?.(method, params);
      },
    });
    self.session = this;
  }

  override async prompt(blocks: readonly AcpContentBlock[], signal?: AbortSignal, meta?: Record<string, unknown>): Promise<AcpPromptResponse> {
    const promptId = `tau-${randomUUID()}`;
    const stop = new AbortController();
    const forward = () => stop.abort();
    signal?.addEventListener("abort", forward, { once: true });
    const completion = new Promise<AcpPromptResponse>((resolve, reject) => { this.pending.set(promptId, { resolve, reject }); });
    const rpc = super.prompt(blocks, stop.signal, { ...meta, promptId, requestId: promptId });
    try {
      return await Promise.race([rpc.catch((error: unknown) => { throw error instanceof AcpRequestError && error.code === RATE_LIMITED ? new Error(USAGE_LIMIT_MESSAGE) : error; }), completion]);
    } finally {
      signal?.removeEventListener("abort", forward);
      this.pending.delete(promptId);
      this.completed.push(promptId);
      this.completed.splice(0, Math.max(0, this.completed.length - COMPLETED_IDS));
      // A prompt the notification ended leaves its request open; this releases it.
      stop.abort();
      rpc.catch(() => undefined);
    }
  }

  /** Asks Grok to stop; a prompt it does not answer soon counts as cancelled rather than taking the process down. */
  override async cancel(): Promise<void> {
    const stopping = super.cancel();
    const grace = Math.min(2_000, this.timeouts.cancelMs);
    const answered = await Promise.race([stopping.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), grace).unref?.())]);
    if (!answered) for (const entry of [...this.pending.values()]) entry.resolve({ stopReason: "cancelled" });
    await stopping;
  }

  private promptComplete(params: PromptComplete): void {
    if (!params || (this.sessionId && params.sessionId !== this.sessionId)) return;
    const promptId = typeof params.promptId === "string" ? params.promptId : undefined;
    if (promptId && this.completed.includes(promptId)) return;
    const entry = promptId ? this.pending.get(promptId) : this.pending.values().next().value;
    if (!entry) return;
    const stopReason = typeof params.stopReason === "string" ? params.stopReason : undefined;
    if (stopReason === "rate_limit") entry.reject(new Error(USAGE_LIMIT_MESSAGE));
    else if (stopReason === "error") entry.reject(new Error(agentResultMessage(params.agentResult) ?? "Grok could not finish the prompt."));
    else entry.resolve({ stopReason: stopReason && STOP_REASONS.has(stopReason) ? stopReason : "end_turn" });
  }
}

export interface GrokSessionOptions {
  command: string;
  /** The instance's extra launch arguments, then the agent's own. */
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientVersion: string;
  spawn?(input: AcpSpawnInput): AcpProcess;
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
  onElicitation?(request: AcpElicitationRequest): Promise<AcpElicitationAnswer>;
  onNotification?(method: string, params: unknown): void;
  onExit?(error: AcpExitedError | undefined): void;
  onStderrLine?(line: string): void;
  mcpServers?: readonly AcpMcpServer[];
  timeouts?: { handshakeMs?: number; sessionMs?: number; cancelMs?: number; signInMs?: number };
}

export function grokSpawnInput(options: Pick<GrokSessionOptions, "command" | "args" | "cwd" | "env">): AcpSpawnInput {
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { command: options.command, args: [...options.args], cwd: options.cwd, env };
}

function signInError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /auth|log ?in|sign ?in|unauthori[sz]ed|token/iu.test(message) ? new Error(`${SIGN_IN_HINT}\n${message}`) : error instanceof Error ? error : new Error(message);
}

function createSession(options: GrokSessionOptions): GrokSession {
  return new GrokSession({
    agentName: "Grok",
    process: (options.spawn ?? spawnAcpProcess)(grokSpawnInput(options)),
    cwd: options.cwd,
    clientInfo: { name: "tau", version: options.clientVersion },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    onUpdate: options.onUpdate,
    onPermission: options.onPermission,
    ...(options.onElicitation ? { onElicitation: options.onElicitation } : {}),
    ...(options.onNotification ? { onNotification: options.onNotification } : {}),
    ...(options.onExit ? { onExit: options.onExit } : {}),
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    // Grok takes Tau's http server without listing the transport.
    checkMcpTransports: false,
    timeouts: { signInMs: 60_000, ...options.timeouts },
  });
}

/** Spawns the agent, shakes hands and signs in with the CLI's login or `XAI_API_KEY`; the caller creates or loads the session. */
export async function openGrokSession(options: GrokSessionOptions): Promise<GrokSession> {
  const session = createSession(options);
  try {
    const initialized = await session.initialize();
    const method = grokAuthMethod(options.env);
    if (!initialized.authMethods?.length || initialized.authMethods.some((entry) => entry.id === method)) {
      await session.authenticate(method).catch((error: unknown) => { throw signInError(error); });
    }
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

/**
 * The handshake alone: Grok names its models and commands in `initialize`,
 * so a probe needs no sign-in and starts no session (and no MCP server).
 */
export async function probeGrok(options: Omit<GrokSessionOptions, "onUpdate" | "onPermission">): Promise<AcpInitializeResult> {
  const session = createSession({ ...options, onUpdate: () => undefined, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) });
  try {
    return await session.initialize();
  } finally {
    await session.close().catch(() => undefined);
  }
}
