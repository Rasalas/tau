import {
  clientMessageFingerprint,
  knownSkillNames,
  prepareSkillPrompt,
  validatePreparedPrompt,
  type AgentRuntimeAdapter,
  type BackendPrompt,
  type ExtensionUiAnswer,
  type PreparedPrompt,
  type RuntimePermissionLevel,
  type ThreadBackendCapabilities,
  type ThreadBackendPromptInput,
  type ThreadBackendPromptResult,
  type ThreadBackendState,
  type ThreadCatalogView,
  type ThreadRuntimeBackend,
  type ThreadRuntimeEvent,
  type ThreadTitleSource,
  type TurnActivityStore,
  type UiComposerCommand,
  type UiContextUsage,
  type UiMessage,
  type UiModel,
  type UiSkillDraft,
} from "tau/host-extension";
import { AcpTurnTranslator, type AcpCommand, type AcpPromptResponse, type AcpSessionUpdate, type AcpTurnOutcome } from "./events.js";
import type { AcpContentBlock, AcpInitializeResult } from "./session.js";
import { activityHistory, derivedTitle, imagesOf, promptBlocks } from "./thread.js";

/** What a thread backend needs of a live ACP session; `AcpAgentSession` is the real one. */
export interface AcpLiveSession {
  readonly closed: boolean;
  readonly sessionId: string | undefined;
  readonly initialized?: AcpInitializeResult;
  readonly stderr: string;
  prompt(blocks: readonly AcpContentBlock[], signal?: AbortSignal): Promise<AcpPromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** The part of a kit's session store the shared backend writes. */
export interface AcpTranscriptStore {
  appendMessages(threadId: string, cwd: string, messages: readonly UiMessage[]): Promise<void>;
  setTitle(threadId: string, cwd: string, title: string, source: ThreadTitleSource): Promise<void>;
}

/** A stored message as the kits' stores keep it. */
export interface AcpStoredMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
}

export interface AcpThreadBackendOptions {
  adapter: AgentRuntimeAdapter;
  /** Where the thread's tool cards are kept across restarts. */
  activity?: TurnActivityStore;
  onMessage?(message: UiMessage): void;
  onEvent?(event: ThreadRuntimeEvent): void;
  ask?(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
  permissionLevel?: () => RuntimePermissionLevel;
  now?(): number;
}

export interface AcpTurn {
  translator: AcpTurnTranslator;
  text: string;
  blocks: AcpContentBlock[];
  /** The prompt went out; from here on updates are this turn's and not a loaded session's replay. */
  posted?: boolean;
  status?: "completed" | "interrupted" | "error";
  /** Resolves when the turn has settled, however it ended. */
  done: Promise<void>;
  finish(): void;
}

/** How a kit judges a finished turn; absent fields keep what the stop reason says. */
export interface AcpTurnVerdict {
  status?: "error";
  error?: string;
}

/**
 * The thread owner every ACP runtime shares: one ACP session per live thread,
 * opened on the first turn. A turn is one `session/prompt`; follow-ups wait
 * behind it, a steer stops it and takes its place. Updates before the prompt
 * goes out (a loaded session's replay) only state facts. A kit supplies the
 * session, the catalog and what happens around each prompt.
 */
export abstract class AcpThreadBackend<S extends AcpLiveSession> implements ThreadRuntimeBackend {
  readonly kind: string;
  readonly runtimeAdapter: AgentRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  capabilities: ThreadBackendCapabilities;
  protected readonly now: () => number;
  protected acpSessionId?: string;
  protected messages: UiMessage[] = [];
  protected live?: S;
  private opening?: Promise<S>;
  protected readonly turns: AcpTurn[] = [];
  private tail: Promise<void> = Promise.resolve();
  protected title?: string;
  protected titleSource?: ThreadTitleSource;
  protected commands: AcpCommand[] = [];
  protected contextUsage?: UiContextUsage;
  /** Cumulative session cost, when the agent reports one. */
  protected sessionCostUsd?: number;
  /** Transcript writes in flight; a turn waits for them before it reports back. */
  protected persisting: Promise<void> = Promise.resolve();
  /** A failed start is also a notice on the transcript; a kit whose sign-in reports its own failure turns it off. */
  protected readonly noticeOnStartFailure: boolean = true;

  /**
   * @param agent How messages name the agent: `Cursor`.
   * @param idPrefix How message ids start: `cursor`.
   */
  constructor(
    readonly threadId: string,
    readonly cwd: string,
    protected readonly agent: string,
    protected readonly idPrefix: string,
    protected readonly store: AcpTranscriptStore,
    protected readonly base: AcpThreadBackendOptions,
  ) {
    this.runtimeAdapter = base.adapter;
    this.kind = base.adapter.id;
    this.now = base.now ?? Date.now;
    this.capabilities = {
      // The agent loads the stored session itself, so a continuation is an
      // ordinary turn; the protocol has no message kind the transcript hides.
      resume: {
        hiddenPrompt: false,
        notice: async (text) => { this.report({ type: "notice", message: text, level: "info" }); },
      },
      ...activityHistory(threadId, base.activity),
    };
  }

  abstract start(mode: "create" | "resume"): Promise<void>;
  abstract catalogView(): ThreadCatalogView;
  abstract models(): Promise<UiModel[]>;
  /** Spawns and signs in, and creates, resumes or loads the ACP session. */
  protected abstract openSession(): Promise<S>;

  /** Before each prompt: model, effort, mode or access level set on the session where they differ. */
  protected async beforePrompt(_live: S, _turn: AcpTurn): Promise<void> {}
  /** After each answered prompt: usage and what else the kit keeps; a verdict can fail the turn. */
  protected async afterTurn(_live: S, _turn: AcpTurn, _outcome: AcpTurnOutcome): Promise<AcpTurnVerdict | void> {}
  /** Sends the turn; a kit with its own completion signal wraps it. */
  protected send(live: S, turn: AcpTurn): Promise<AcpPromptResponse> {
    return live.prompt(turn.blocks);
  }

  get providerSessionId(): string { return this.acpSessionId ?? this.threadId; }

  /** The transcript as stored, each message under the id it was shown with. */
  protected restoreMessages(stored: readonly AcpStoredMessage[]): void {
    this.messages = stored.map((message, index) => ({
      id: message.id ?? `${this.idPrefix}-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    }));
  }

  async transcript(): Promise<UiMessage[]> { return this.messages.map((message) => ({ ...message })); }

  /** The agent's own slash commands, once a session announced them. */
  composerCommands(): UiComposerCommand[] {
    return this.commands.map((command) => ({ name: command.name, ...(command.description ? { description: command.description } : {}), ...(command.hint ? { argumentHint: command.hint } : {}), source: "prompt" as const }));
  }

  state(): ThreadBackendState {
    const running = this.turns[0];
    return {
      streaming: running !== undefined,
      idle: running === undefined,
      hasMessages: this.messages.length > 0,
      ...(this.title ? { title: this.title } : {}),
      ...(this.titleSource ? { titleSource: this.titleSource } : {}),
      activeTools: [...(running?.translator.running.values() ?? [])].map((tool) => tool.name),
      supportsImageInput: this.live?.initialized?.agentCapabilities?.promptCapabilities?.image !== false,
      extensionCount: 0,
    };
  }

  protected liveSession(): S | undefined {
    return this.live && !this.live.closed ? this.live : undefined;
  }

  protected permissionLevel(): RuntimePermissionLevel {
    return this.base.permissionLevel?.() ?? "full";
  }

  async preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
    const commands = this.composerCommands();
    const prepared = prepareSkillPrompt(text, this.runtimeAdapter, commands, skill);
    const result: PreparedPrompt = {
      tauThreadId: this.threadId,
      providerSessionId: this.providerSessionId,
      sessionId: this.threadId,
      backendKind: this.kind,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, [...knownSkillNames(commands)]),
    };
    validatePreparedPrompt(text, result, this.bound());
    return result;
  }

  private bound() {
    return { backendKind: this.kind, threadId: this.threadId, providerSessionId: this.providerSessionId, runtimeCapabilities: this.runtimeAdapter.capabilities, commands: this.composerCommands() };
  }

  async prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult> {
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error(`Unsupported ${this.agent} delivery.`);
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    validatePreparedPrompt(input.text, prepared, this.bound());
    const clientMessageId = input.identity?.clientMessageId;
    if (clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
      if (existing?.text === prepared.visibleText) return {};
      if (existing) throw new Error(`The ${this.agent} transcript already holds a different message '${clientMessageId}'.`);
    }
    const images = imagesOf(input.attachments);
    const user: UiMessage = {
      id: `${this.idPrefix}-user-${clientMessageId ?? this.now()}`,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(input.identity?.clientTurnId ? { clientTurnId: input.identity.clientTurnId } : {}),
      role: "user",
      text: prepared.visibleText,
      ...(images.length ? { images } : {}),
      timestamp: this.now(),
    };
    this.messages.push(user);
    await this.store.appendMessages(this.threadId, this.cwd, [user]);
    // No title is stored here: the thread index names an unnamed thread after
    // its first message, and a stored name would stop the title generator.
    this.deliver(user);
    input.onAdmitted?.(true);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const turn: AcpTurn = { translator: new AcpTurnTranslator(this.now, this.idPrefix), text: prepared.visibleText, blocks: promptBlocks(prepared.runtimeText, input.attachments), done, finish };
    if (input.delivery === "steer" && this.turns.length > 0) {
      // A steer takes the running turn's place: the agent stops, then hears the new text.
      const running = this.turns[0]!;
      this.turns.splice(1, 0, turn);
      this.reportQueue();
      await this.cancelRunning(running);
    } else {
      this.turns.push(turn);
      if (this.turns.length > 1) this.reportQueue();
    }
    const run = this.tail.then(() => this.runTurn(turn));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runTurn(turn: AcpTurn): Promise<ThreadBackendPromptResult> {
    if (turn.status) return {};
    const index = this.turns.indexOf(turn);
    if (index > 0) {
      this.turns.splice(index, 1);
      this.turns.unshift(turn);
    }
    this.report({ type: "turn-started" });
    this.reportQueue();
    try {
      const live = await this.ensureSession();
      await this.beforePrompt(live, turn);
      if (turn.status) return {};
      let response: AcpPromptResponse;
      turn.posted = true;
      try {
        response = await this.send(live, turn);
      } catch (error) {
        if (turn.status) return {};
        const message = error instanceof Error ? error.message : String(error);
        this.report({ type: "notice", message: `${this.agent} reported an error: ${message}${live.stderr.trim() ? `\n${live.stderr.trim()}` : ""}`, level: "error" });
        this.settle(turn, "error", turn.translator.abandon(), message);
        throw error;
      }
      const events = turn.translator.finish(response);
      const outcome = turn.translator.outcome!;
      const verdict = await this.afterTurn(live, turn, outcome);
      if (outcome.stopReason === "refusal") this.report({ type: "notice", message: `${this.agent} declined to continue this turn.`, level: "warning" });
      if (verdict?.status === "error") {
        this.settle(turn, "error", events, verdict.error);
        return {};
      }
      this.settle(turn, outcome.cancelled ? "interrupted" : "completed", events);
      return { assistantText: outcome.texts.join("\n\n") };
    } catch (error) {
      if (!turn.status && this.noticeOnStartFailure) {
        const message = error instanceof Error ? error.message : String(error);
        this.report({ type: "notice", message: `${this.agent} could not start: ${message}`, level: "error" });
        this.settle(turn, "error", turn.translator.abandon(), message);
      }
      throw error;
    } finally {
      if (!turn.status) this.settle(turn, "error", turn.translator.abandon());
      await this.persisting;
    }
  }

  protected settle(turn: AcpTurn, status: NonNullable<AcpTurn["status"]>, events: ThreadRuntimeEvent[], error?: string): void {
    if (turn.status) return;
    for (const event of events) this.handleEvent(event);
    turn.status = status;
    const index = this.turns.indexOf(turn);
    if (index >= 0) this.turns.splice(index, 1);
    this.noteFacts(turn.translator);
    this.report({ type: "usage" });
    this.report({ type: "turn-settled", status, ...(status === "error" && error ? { error } : {}) });
    this.reportQueue();
    turn.finish();
  }

  protected noteFacts(translator: AcpTurnTranslator): void {
    if (translator.facts.commands) this.commands = translator.facts.commands;
    if (translator.facts.contextUsage) this.contextUsage = translator.facts.contextUsage;
    if (translator.facts.sessionCostUsd !== undefined) this.sessionCostUsd = translator.facts.sessionCostUsd;
  }

  /** The live session, or one opened for it; two turns never open two. */
  protected ensureSession(): Promise<S> {
    const live = this.liveSession();
    if (live) return Promise.resolve(live);
    this.opening ??= this.openSession().then((session) => { this.live = session; return session; }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  /** Updates outside a posted prompt are a loaded session's replay or session facts; only the facts count. */
  protected onUpdate(update: AcpSessionUpdate): void {
    const turn = this.turns[0];
    if (!turn?.posted) {
      const probe = new AcpTurnTranslator(this.now, this.idPrefix);
      if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") probe.push(update);
      this.noteFacts(probe);
      return;
    }
    for (const event of turn.translator.push(update)) this.handleEvent(event);
  }

  /** The running turn, once its prompt went out. */
  protected postedTurn(): AcpTurn | undefined {
    const turn = this.turns[0];
    return turn?.posted ? turn : undefined;
  }

  /** Events the kit made itself (a plan, a tool of its own) on the running turn. */
  protected emit(events: readonly ThreadRuntimeEvent[]): void {
    for (const event of events) this.handleEvent(event);
  }

  protected onExit(session: S | undefined, error: Error | undefined): void {
    if (!session || this.live !== session) return;
    this.live = undefined;
    if (error) this.report({ type: "notice", message: error.message, level: "error" });
    for (const turn of [...this.turns]) {
      if (turn.posted) this.settle(turn, error ? "error" : "interrupted", turn.translator.abandon(), error?.message);
    }
  }

  protected async cancelRunning(turn: AcpTurn): Promise<void> {
    const live = this.liveSession();
    if (live && turn.posted) await live.cancel().catch(() => undefined);
    else if (!turn.posted) this.settle(turn, "interrupted", []);
    await turn.done;
  }

  async abort(): Promise<void> {
    const running = this.turns[0];
    if (!running) return;
    await this.cancelRunning(running);
  }

  protected handleEvent(event: ThreadRuntimeEvent): void {
    if (event.type === "assistant-end") {
      this.messages.push(event.message);
      const message = event.message;
      this.persisting = this.persisting.then(() => this.store.appendMessages(this.threadId, this.cwd, [message])).catch(() => undefined);
      this.deliver(event.message);
      return;
    }
    this.report(event);
  }

  private deliver(message: UiMessage): void {
    if (this.base.onEvent) {
      this.base.onEvent(message.role === "user" ? { type: "user-message", message } : { type: "assistant-end", message });
      return;
    }
    this.base.onMessage?.(message);
  }

  protected report(event: ThreadRuntimeEvent): void {
    this.base.onEvent?.(event);
  }

  private reportQueue(): void {
    this.report({ type: "queue", steering: [], followUp: this.turns.slice(1).map((turn) => turn.text) });
  }

  async persist(messages: readonly UiMessage[]): Promise<void> {
    await this.store.appendMessages(this.threadId, this.cwd, messages);
  }

  async setTitle(title: string, source: ThreadTitleSource): Promise<void> {
    const safe = derivedTitle(title) ?? "Untitled thread";
    this.title = safe;
    this.titleSource = source;
    await this.store.setTitle(this.threadId, this.cwd, safe, source);
  }

  async waitForIdle(): Promise<void> {
    while (this.turns.length > 0) await this.turns[0]!.done;
    await this.persisting;
  }

  async dispose(): Promise<void> {
    const live = this.live;
    this.live = undefined;
    if (live && !live.closed) await live.close();
    await this.persisting;
  }
}
