import { randomUUID } from "node:crypto";
import type { AccountInfo, EffortLevel, McpServerConfig, ModelInfo, Options, PermissionMode, SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "./runtime-adapter.js";
import { authenticationException, authenticationFailure, ClaudeAuthenticationError } from "./auth-failure.js";

export type SendPriority = NonNullable<SDKUserMessage["priority"]>;
export type UserContent = SDKUserMessage["message"]["content"];
export type ResultMessage = SDKMessage & { type: "result" };

export interface ClaudeSdkSessionOptions {
  query: ClaudeQuery;
  /** Everything but the prompt; the session adds its own abort controller. */
  options: Options;
  claudeSessionId: string;
  /** `unclaimed` marks a result that settles no send: a turn the CLI ran on its own. */
  onMessage(message: SDKMessage, unclaimed?: boolean): void;
  /** The query ended: the CLI exited, was closed, or failed. */
  onExit(error: unknown | undefined): void;
  /** Names the real reason before a failure is reported, such as the CLI's scope running out of memory. */
  explainExit?(error: unknown): Promise<unknown>;
  /**
   * Servers registered over the control channel right after the CLI starts, so
   * their credentials never reach its command line. The first prompt waits for it.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /** Names of the servers that did not come up, or all of them on a timeout. */
  onMcpUnavailable?(servers: string[], reason: "failed" | "timeout"): void;
  /** How long the CLI gets to answer the registration; the SDK sets no deadline of its own. */
  mcpTimeoutMs?: number;
}

/** The CLI answers once each server connected or hit its own 30 s timeout. */
const MCP_REGISTRATION_TIMEOUT_MS = 90_000;
const QUERY_CLOSE_TIMEOUT_MS = 10_000;

/** No SDK error text here: control failures can echo MCP authorization headers. */
class ClaudeMcpRegistrationTimeoutError extends Error {
  constructor() {
    super("Claude Code timed out while connecting its MCP tools. Retry the turn; if it keeps failing, check Claude Code and the server logs.");
    this.name = "ClaudeMcpRegistrationTimeoutError";
  }
}

interface QueryAttempt {
  controller: AbortController;
  query?: ReturnType<ClaudeQuery>;
  loop?: Promise<void>;
  retired: boolean;
  sent: boolean;
  ready: Promise<boolean>;
  releaseReady(ready: boolean): void;
  releaseMcp?(): void;
  process?: SpawnedProcess;
  processExit?: Promise<void>;
  processExited?: boolean;
  removeExitListener?(): void;
  disposal?: Promise<void>;
}

async function closeBounded(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude Code could not stop its previous session. Retry after it has stopped.")), QUERY_CLOSE_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

interface PendingSend {
  dispatched?: boolean;
  resolve(result: ResultMessage): void;
  reject(error: unknown): void;
}

function sessionEnded(): Error {
  const error = new Error("Claude Code session ended before the turn finished.");
  error.name = "AbortError";
  return error;
}

/**
 * One live `query()` per thread, fed by a queue of user
 * messages (ADR 0004). A turn is a Tau-side notion layered on the SDK's loop:
 * every send carries a uuid, and the `result` frame that consumed it settles
 * it, so a steer that joined a running turn resolves with that turn and a
 * follow-up with its own.
 */
export class ClaudeSdkSession {
  readonly abortController = new AbortController();
  private readonly queue: SDKUserMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly pending = new Map<string, PendingSend>();
  private attempt?: QueryAttempt;
  private loop?: Promise<void>;
  private ended = false;
  private exitError: unknown;
  private finished = false;

  constructor(private readonly options: ClaudeSdkSessionOptions) {}

  start(): void {
    if (this.attempt || this.ended) return;
    this.abortController.signal.addEventListener("abort", this.onAbort, { once: true });
    try {
      const attempt = this.openAttempt();
      this.loop = this.run(attempt, 0);
    } catch (error) {
      this.ended = true;
      this.abortController.signal.removeEventListener("abort", this.onAbort);
      throw error;
    }
  }

  private readonly onAbort = (): void => {
    this.ended = true;
    const attempt = this.attempt;
    attempt?.releaseReady(false);
    attempt?.releaseMcp?.();
    attempt?.controller.abort();
    this.wake();
  };

  private openAttempt(): QueryAttempt {
    let releaseReady!: QueryAttempt["releaseReady"];
    const ready = new Promise<boolean>((resolve) => { releaseReady = resolve; });
    const attempt: QueryAttempt = { controller: new AbortController(), ready, releaseReady, retired: false, sent: false };
    this.attempt = attempt;
    // Even callers supplying SDK options directly must keep credentials on stdin.
    const { mcpServers: _servers, ...options } = this.options.options;
    const spawn = options.spawnClaudeCodeProcess;
    const current = () => !attempt.retired && !this.ended && !attempt.controller.signal.aborted;
    const lifecycle: Pick<Options, "spawnClaudeCodeProcess" | "canUseTool" | "onUserDialog" | "stderr"> = {};
    if (spawn) lifecycle.spawnClaudeCodeProcess = (input) => {
      if (!current()) throw sessionEnded();
      const child = spawn(input);
      attempt.process = child;
      attempt.processExited = child.exitCode !== null || child.signalCode != null;
      attempt.processExit = new Promise<void>((resolve) => {
        const onExit = () => { attempt.processExited = true; resolve(); };
        if (attempt.processExited) resolve();
        else child.once("exit", onExit);
        attempt.removeExitListener = () => child.off("exit", onExit);
      });
      return child;
    };
    if (options.canUseTool) lifecycle.canUseTool = async (name, input, context) => {
      if (!current()) throw sessionEnded();
      const answer = await options.canUseTool!(name, input, { ...context, signal: AbortSignal.any([context.signal, attempt.controller.signal]) });
      if (!current()) throw sessionEnded();
      return answer;
    };
    if (options.onUserDialog) lifecycle.onUserDialog = async (request, context) => {
      if (!current()) throw sessionEnded();
      const answer = await options.onUserDialog!(request, { ...context, signal: AbortSignal.any([context.signal, attempt.controller.signal]) });
      if (!current()) throw sessionEnded();
      return answer;
    };
    if (options.stderr) lifecycle.stderr = (chunk) => { if (current()) options.stderr!(chunk); };
    try {
      attempt.query = this.options.query({ prompt: this.messages(attempt), options: { ...options, ...lifecycle, abortController: attempt.controller } });
    } catch (error) {
      // A custom query can spawn and then throw before returning its SDK handle.
      void this.dispose(attempt, true).catch(() => undefined);
      throw error;
    }
    return attempt;
  }

  /** The queue belongs to the session; each CLI gets a separate gate into it. */
  private async run(attempt: QueryAttempt, retries: number): Promise<void> {
    attempt.loop = this.consume(attempt);
    try {
      const servers = this.options.mcpServers ?? this.options.options.mcpServers;
      const outcome = servers && Object.keys(servers).length > 0 ? await this.registerMcpServers(attempt, servers) : { failed: [] };
      if (this.ended || attempt.retired || outcome === "released") return;
      if (outcome === "timeout" && this.options.options.resume !== undefined) {
        // Nothing has left this attempt's gate. Never replay an already-delivered prompt.
        if (!attempt.sent && retries === 0) {
          await closeBounded(Promise.all([this.dispose(attempt, true), attempt.loop]));
          if (!this.ended) await this.run(this.openAttempt(), retries + 1);
          return;
        }
        throw new ClaudeMcpRegistrationTimeoutError();
      }
      if (outcome === "timeout") this.options.onMcpUnavailable?.(Object.keys(servers!), "timeout");
      else if (outcome.failed.length > 0) this.options.onMcpUnavailable?.(outcome.failed, "failed");
      attempt.releaseReady(true);
      await attempt.loop;
    } catch (error) {
      // Retire before aborting: late frames and registration answers belong to the old CLI.
      try { await this.dispose(this.attempt ?? attempt, true); } catch { /* Report the original failure. */ }
      if (!this.finished) this.finish(this.ended ? undefined : error);
    } finally {
      attempt.releaseReady(false);
      if (this.ended) {
        await this.dispose(attempt, this.abortController.signal.aborted).catch(() => undefined);
        this.finish(undefined);
      }
    }
  }

  /** Registration failures are sanitized; only a resume timeout replaces the CLI. */
  private async registerMcpServers(attempt: QueryAttempt, servers: Record<string, McpServerConfig>): Promise<"released" | "timeout" | { failed: string[] }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const released = new Promise<"released">((resolve) => { attempt.releaseMcp = () => resolve("released"); });
    const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.options.mcpTimeoutMs ?? MCP_REGISTRATION_TIMEOUT_MS); });
    // Promise.resolve also catches synchronous throws from a control implementation.
    const answer = Promise.resolve().then(() => this.ended || attempt.retired ? undefined : attempt.query!.setMcpServers(servers)).then(
      (result) => ({ failed: Object.keys(result?.errors ?? {}) }),
      () => ({ failed: Object.keys(servers) }),
    );
    try { return await Promise.race([answer, timedOut, released]); }
    finally { clearTimeout(timer); attempt.releaseMcp = undefined; }
  }

  /** Dispose SDK hooks and control requests, and confirm the owned process exited before replacement. */
  private dispose(attempt: QueryAttempt, abort: boolean): Promise<void> {
    if (attempt.disposal) return attempt.disposal;
    attempt.retired = true;
    attempt.releaseReady(false);
    attempt.releaseMcp?.();
    this.wake();
    attempt.disposal = closeBounded((async () => {
      if (abort) attempt.controller.abort();
      // Abort/close can return before exit. The guardian's kill also reaps descendants.
      let killFailed = false;
      try { if (attempt.process && !attempt.processExited) attempt.process.kill("SIGKILL"); }
      catch { killFailed = true; }
      const query = attempt.query;
      try {
        const disposable = query as { [Symbol.asyncDispose]?: () => Promise<void> } | undefined;
        const dispose = disposable?.[Symbol.asyncDispose];
        if (dispose) await dispose.call(disposable);
        else query?.close?.();
        if (killFailed) throw new Error("Claude Code could not stop its previous session. Retry after it has stopped.");
        await attempt.processExit;
      } catch {
        throw new Error("Claude Code could not stop its previous session. Retry after it has stopped.");
      }
    })()).finally(() => attempt.removeExitListener?.());
    return attempt.disposal;
  }

  /** Sends still waiting for the result that consumes them. */
  get busy(): boolean { return this.pending.size > 0; }
  get closed(): boolean { return this.ended; }

  /** Resolves with the result of the turn that consumed the message. */
  send(content: UserContent, priority: SendPriority): Promise<ResultMessage> {
    if (this.ended) return Promise.reject(this.exitError ?? sessionEnded());
    const uuid = randomUUID();
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.options.claudeSessionId,
      uuid: uuid as SDKUserMessage["uuid"],
      priority,
    };
    return new Promise<ResultMessage>((resolve, reject) => {
      this.pending.set(uuid, { resolve, reject });
      this.queue.push(message);
      this.wake();
    });
  }

  interrupt(): Promise<unknown> {
    return this.attempt?.query?.interrupt() ?? Promise.resolve(undefined);
  }

  /** The CLI answers with a `task_notification` of status `stopped`. */
  stopTask(taskId: string): Promise<void> {
    return this.attempt?.query?.stopTask(taskId) ?? Promise.resolve();
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.options.options.permissionMode = mode;
    return (!this.attempt?.retired ? this.attempt?.query?.setPermissionMode(mode) : undefined) ?? Promise.resolve();
  }

  setModel(model?: string): Promise<void> {
    this.options.options.model = model;
    return (!this.attempt?.retired ? this.attempt?.query?.setModel(model) : undefined) ?? Promise.resolve();
  }

  /** `null` returns the session to the CLI's own default. */
  setEffort(effort: EffortLevel | null): Promise<void> {
    this.options.options.effort = effort ?? undefined;
    return (!this.attempt?.retired ? this.attempt?.query?.applyFlagSettings({ effortLevel: effort }) : undefined) ?? Promise.resolve();
  }

  /** The login the running CLI uses; answered locally, no request goes out. */
  async accountInfo(): Promise<AccountInfo | undefined> {
    return this.attempt?.query?.accountInfo?.();
  }

  supportedModels(): Promise<ModelInfo[]> {
    return this.attempt?.query?.supportedModels() ?? Promise.resolve([]);
  }

  /** Ends the input, aborts the CLI, and waits for the loop; pending sends are rejected. */
  async close(): Promise<void> {
    this.ended = true;
    this.abortController.abort();
    await closeBounded(Promise.all([this.attempt ? this.dispose(this.attempt, true) : undefined, this.loop])).catch(() => undefined);
    this.finish(undefined);
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private async *messages(attempt: QueryAttempt): AsyncGenerator<SDKUserMessage> {
    if (!await attempt.ready) return;
    while (!this.ended && !attempt.retired) {
      const next = this.queue.shift();
      if (next) {
        attempt.sent = true;
        const pending = this.pending.get(next.uuid!);
        if (pending) pending.dispatched = true;
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async consume(attempt: QueryAttempt): Promise<void> {
    let error: unknown;
    try {
      for await (const message of attempt.query!) {
        if (attempt.retired || this.ended) break;
        const authentication = authenticationFailure(message);
        if (message.type === "result") {
          const uuids = this.resultSends(message);
          if (uuids.length === 0) {
            this.options.onMessage(message, true);
          } else {
            // The backend settles its turn synchronously in onMessage. Validate
            // first so background results cannot advance its turn queue.
            this.options.onMessage(message);
            this.settle(message, uuids);
          }
        } else {
          this.options.onMessage(message);
        }
        if (authentication) {
          error = authentication;
          // Stop the CLI and all of its children before it can retry or consume
          // another queued send. No result frame is required to end this run.
          this.abortController.abort();
          this.ended = true;
          attempt.releaseMcp?.();
          this.wake();
          break;
        }
      }
    } catch (caught) {
      error ??= this.abortController.signal.aborted ? undefined : authenticationException(caught) ?? caught;
      if (error instanceof ClaudeAuthenticationError) this.abortController.abort();
    }
    if (attempt.retired) return;
    if (error !== undefined && this.options.explainExit) error = await this.options.explainExit(error).catch(() => error);
    if (!attempt.retired) this.finish(error);
  }

  /** Resolve correlation before publishing a result to the turn owner. */
  private resultSends(result: ResultMessage): string[] {
    const named = [...new Set([
      ...(result.user_message_uuids ?? []),
      ...(result.user_message_uuid ? [result.user_message_uuid] : []),
    ])];
    if (named.length > 0) return named.filter((uuid) => this.pending.get(uuid)?.dispatched);
    // Newer CLIs run turns of their own for background tasks and peer messages.
    // Only old results without an origin, or human results, may use the fallback.
    if (result.origin !== undefined && result.origin.kind !== "human") return [];
    // Resume handshakes have no prompt; a named /compact result may have zero turns.
    const localCommand = "local_command" in result && typeof result.local_command === "string" && result.local_command.length > 0;
    if (result.num_turns === 0 && !localCommand) return [];
    const oldest = [...this.pending].find(([, send]) => send.dispatched)?.[0];
    return oldest === undefined ? [] : [oldest];
  }

  private settle(result: ResultMessage, uuids: string[]): void {
    for (const uuid of uuids) {
      const send = this.pending.get(uuid);
      this.pending.delete(uuid);
      send?.resolve(result);
    }
  }

  private finish(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.abortController.signal.removeEventListener("abort", this.onAbort);
    this.ended = true;
    this.exitError = error;
    this.attempt?.releaseMcp?.();
    this.attempt?.releaseReady(false);
    this.wake();
    const failure = error ?? sessionEnded();
    for (const send of this.pending.values()) send.reject(failure);
    this.pending.clear();
    this.queue.length = 0;
    this.options.onExit(error);
  }
}
