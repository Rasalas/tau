import { randomUUID } from "node:crypto";
import type { AccountInfo, EffortLevel, ModelInfo, Options, PermissionMode, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "./runtime-adapter.js";

export type SendPriority = NonNullable<SDKUserMessage["priority"]>;
export type UserContent = SDKUserMessage["message"]["content"];
export type ResultMessage = SDKMessage & { type: "result" };

export interface ClaudeSdkSessionOptions {
  query: ClaudeQuery;
  /** Everything but the prompt; the session adds its own abort controller. */
  options: Options;
  claudeSessionId: string;
  onMessage(message: SDKMessage): void;
  /** The query ended: the CLI exited, was closed, or failed. */
  onExit(error: unknown | undefined): void;
}

interface PendingSend {
  resolve(result: ResultMessage): void;
  reject(error: unknown): void;
}

function sessionEnded(): Error {
  const error = new Error("Claude Code session ended before the turn finished.");
  error.name = "AbortError";
  return error;
}

/**
 * One `query()` held open for a thread's whole life, fed by a queue of user
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
  private query?: ReturnType<ClaudeQuery>;
  private loop?: Promise<void>;
  private ended = false;
  private exitError: unknown;

  constructor(private readonly options: ClaudeSdkSessionOptions) {}

  start(): void {
    if (this.query) return;
    this.query = this.options.query({ prompt: this.messages(), options: { ...this.options.options, abortController: this.abortController } });
    this.loop = this.consume();
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
    return this.query?.interrupt() ?? Promise.resolve(undefined);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.query?.setPermissionMode(mode) ?? Promise.resolve();
  }

  setModel(model?: string): Promise<void> {
    return this.query?.setModel(model) ?? Promise.resolve();
  }

  /** `null` returns the session to the CLI's own default. */
  setEffort(effort: EffortLevel | null): Promise<void> {
    return this.query?.applyFlagSettings({ effortLevel: effort }) ?? Promise.resolve();
  }

  /** The login the running CLI uses; answered locally, no request goes out. */
  async accountInfo(): Promise<AccountInfo | undefined> {
    return this.query?.accountInfo?.();
  }

  supportedModels(): Promise<ModelInfo[]> {
    return this.query?.supportedModels() ?? Promise.resolve([]);
  }

  /** Ends the input, aborts the CLI, and waits for the loop; pending sends are rejected. */
  async close(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.wake();
      this.abortController.abort();
    }
    await this.loop?.catch(() => undefined);
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private async *messages(): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async consume(): Promise<void> {
    let error: unknown;
    try {
      for await (const message of this.query!) {
        if (message.type === "result") {
          const uuids = this.resultSends(message);
          if (uuids.length === 0) continue;
          // The backend settles its turn synchronously in onMessage. Validate
          // first so background results cannot advance its turn queue.
          this.options.onMessage(message);
          this.settle(message, uuids);
        } else {
          this.options.onMessage(message);
        }
      }
    } catch (caught) {
      error = this.abortController.signal.aborted ? undefined : caught;
    }
    this.finish(error);
  }

  /** Resolve correlation before publishing a result to the turn owner. */
  private resultSends(result: ResultMessage): string[] {
    const named = [...new Set([
      ...(result.user_message_uuids ?? []),
      ...(result.user_message_uuid ? [result.user_message_uuid] : []),
    ])];
    if (named.length > 0) return named.filter((uuid) => this.pending.has(uuid));
    // Newer CLIs run turns of their own for background tasks and peer messages.
    // Only old results without an origin, or human results, may use the fallback.
    if (result.origin !== undefined && result.origin.kind !== "human") return [];
    // Resume handshakes have no prompt; a named /compact result may have zero turns.
    if (result.num_turns === 0 && !result.local_command) return [];
    const oldest = this.pending.keys().next().value;
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
    this.ended = true;
    this.exitError = error;
    this.wake();
    const failure = error ?? sessionEnded();
    for (const send of this.pending.values()) send.reject(failure);
    this.pending.clear();
    this.options.onExit(error);
  }
}
