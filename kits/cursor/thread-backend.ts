import {
  DEFAULT_THREAD_MODE as DEFAULT_MODE,
  clientMessageFingerprint,
  knownSkillNames,
  prepareSkillPrompt,
  validatePreparedPrompt,
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
  type UiThreadUsage,
} from "tau/host-extension";
import { answerElicitation, autoApproval, permissionDialog } from "../_acp/approvals.js";
import { AcpTurnTranslator, addUsage, type AcpCommand, type AcpPromptResponse, type AcpSessionUpdate } from "../_acp/events.js";
import { configOptionValues, type AcpAgentSession, type AcpContentBlock, type AcpElicitationAnswer, type AcpElicitationRequest, type AcpPermissionRequest, type AcpPermissionResponse, type AcpSelectOption } from "../_acp/session.js";
import { activityHistory, derivedTitle, imagesOf, promptBlocks } from "../_acp/thread.js";
import { DEFAULT_EFFORT, MODEL_PROVIDER, effortOption, thinkingLevels } from "./catalog.js";
import { askQuestionDialogs, extensionCard, planReply, transportFailure, type CursorAskAnswer, type CursorAskQuestion, type CursorCreatePlan } from "./extensions.js";
import type { CursorRuntimeAdapter } from "./runtime-adapter.js";
import type { CursorSessionStore, CursorStoredModel } from "./session-store.js";

/** What the backend needs of a live ACP session; `AcpAgentSession` is the real one. */
export type CursorSessionLike = Pick<AcpAgentSession,
  "closed" | "sessionId" | "modeId" | "initialized" | "configOptions" | "stderr" | "newSession" | "resumeSession" | "loadSession"
  | "modelOptions" | "modeOptions" | "currentModel" | "setModel" | "setMode" | "setConfigOption" | "prompt" | "cancel" | "close" | "handle">;

export interface CursorSessionInput {
  threadId: string;
  cwd: string;
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
  onElicitation(request: AcpElicitationRequest): Promise<AcpElicitationAnswer>;
  onNotification(method: string, params: unknown): void;
  onExit(error: Error | undefined): void;
}

export interface CursorThreadBackendOptions {
  activity?: TurnActivityStore;
  adapter: CursorRuntimeAdapter;
  store: CursorSessionStore;
  instance?: string;
  /** Spawns the CLI and signs in; the backend creates or loads the session itself. */
  openSession(input: CursorSessionInput): Promise<CursorSessionLike>;
  /** The account's models as last seen; read when the thread opens. */
  storedModels?(): Promise<readonly CursorStoredModel[]>;
  onMessage?(message: UiMessage): void;
  onEvent?(event: ThreadRuntimeEvent): void;
  ask?(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
  permissionLevel?: () => RuntimePermissionLevel;
  now?(): number;
}

interface Turn {
  translator: AcpTurnTranslator;
  text: string;
  blocks: AcpContentBlock[];
  /** The prompt went out; from here on updates are this turn's and not a loaded session's replay. */
  posted?: boolean;
  status?: "completed" | "interrupted" | "error";
  done: Promise<void>;
  finish(): void;
}

/** Tau's name for Cursor's plan mode. */
export const PLAN_MODE = "plan";

/** Cursor's mode for the thread's mode and access level; `ask` is Cursor's read-only Q&A mode. */
export function cursorMode(mode: string, level: RuntimePermissionLevel, available: readonly AcpSelectOption[]): string | undefined {
  const find = (...aliases: string[]) => {
    for (const alias of aliases) {
      const match = available.find((option) => option.value.toLowerCase() === alias || option.name.trim().toLowerCase() === alias);
      if (match) return match.value;
    }
    return undefined;
  };
  if (mode === PLAN_MODE) return find("plan", "architect");
  if (level === "read-only") return find("ask", "plan", "architect");
  return find("agent", "code", "default");
}

/**
 * A Cursor thread: one ACP session of `agent acp` per live thread, created on
 * the first turn and loaded by id after a restart. A turn is one
 * `session/prompt`; follow-ups wait behind it, a steer stops it and takes its
 * place. Model, effort and mode are applied before each turn; approvals,
 * questions and forms go to the workbench, a plan becomes a plan card.
 */
export class CursorThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind: string;
  readonly runtimeAdapter: CursorRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities;
  private readonly store: CursorSessionStore;
  private readonly now: () => number;
  private acpSessionId?: string;
  private messages: UiMessage[] = [];
  private live?: CursorSessionLike;
  private opening?: Promise<CursorSessionLike>;
  private readonly turns: Turn[] = [];
  private tail: Promise<void> = Promise.resolve();
  private title?: string;
  private titleSource?: ThreadTitleSource;
  private usage: UiThreadUsage = AcpTurnTranslator.emptyUsage();
  private contextUsage?: UiContextUsage;
  private sessionCostUsd?: number;
  private chosenModel?: string;
  private chosenEffort?: string;
  private mode = DEFAULT_MODE;
  private observedModel?: string;
  private commands: AcpCommand[] = [];
  private modelList: CursorStoredModel[] = [];
  private persisting: Promise<void> = Promise.resolve();

  constructor(readonly threadId: string, readonly cwd: string, private readonly options: CursorThreadBackendOptions) {
    this.runtimeAdapter = options.adapter;
    this.kind = options.adapter.id;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.capabilities = {
      catalogWrite: {
        setModel: (_provider, id) => this.setModel(id),
        setThinkingLevel: (level) => this.setEffort(level),
      },
      mode: {
        modes: () => [PLAN_MODE],
        current: () => this.mode,
        set: (mode) => this.setMode(mode),
      },
      // Cursor loads the stored session itself, so a continuation is an ordinary turn.
      resume: {
        hiddenPrompt: false,
        notice: async (text) => { this.report({ type: "notice", message: text, level: "info" }); },
      },
      ...activityHistory(threadId, options.activity),
    };
  }

  get providerSessionId(): string { return this.acpSessionId ?? this.threadId; }

  async start(mode: "create" | "resume"): Promise<void> {
    const instance = this.options.instance;
    const record = mode === "create" ? await this.store.ensure(this.threadId, this.cwd, instance) : await this.store.get(this.threadId) ?? await this.store.ensure(this.threadId, this.cwd, instance);
    if (record.cwd !== this.cwd) throw new Error("This Cursor thread belongs to another workspace.");
    this.messages = record.messages.map((message, index) => ({
      id: message.id ?? `cursor-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    }));
    this.acpSessionId = record.acpSessionId;
    this.title = record.title;
    this.titleSource = record.titleSource;
    if (record.usage) this.usage = { ...record.usage };
    this.chosenModel = record.model;
    this.chosenEffort = record.effort;
    this.mode = record.mode ?? DEFAULT_MODE;
    this.observedModel = record.observedModel;
    this.modelList = [...await this.options.storedModels?.().catch(() => []) ?? []];
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

  private liveSession(): CursorSessionLike | undefined {
    return this.live && !this.live.closed ? this.live : undefined;
  }

  private currentModel(): string | undefined {
    return this.chosenModel ?? this.liveSession()?.currentModel() ?? this.observedModel;
  }

  /** The efforts the current model offers: from the live session when it runs this model, else from the stored list. */
  private efforts(): string[] {
    const model = this.currentModel();
    const live = this.liveSession();
    if (live && live.currentModel() === model) {
      const values = configOptionValues(effortOption(live.configOptions)).map((entry) => entry.value);
      if (values.length) return values;
    }
    return this.modelList.find((entry) => entry.id === model)?.efforts ?? [];
  }

  catalogView(): ThreadCatalogView {
    const current = this.currentModel();
    const name = this.liveSession()?.modelOptions().find((option) => option.value === current)?.name ?? this.modelList.find((model) => model.id === current)?.name;
    const usage = this.usage.turns > 0 ? { ...this.usage, ...(this.sessionCostUsd !== undefined ? { costUsd: this.sessionCostUsd } : {}) } : undefined;
    return {
      ...(current ? { model: { provider: MODEL_PROVIDER, id: current, name: name ?? current } } : {}),
      thinkingLevel: this.chosenEffort ?? DEFAULT_EFFORT,
      thinkingLevels: thinkingLevels(this.efforts()),
      allTools: [],
      ...(usage ? { usage } : {}),
      ...(this.contextUsage ? { contextUsage: { ...this.contextUsage } } : {}),
    };
  }

  async models(): Promise<UiModel[]> {
    const live = this.liveSession();
    const options = live ? live.modelOptions().map((option) => ({ id: option.value, name: option.name })) : this.modelList;
    return options.map((option) => ({ provider: MODEL_PROVIDER, id: option.id, name: option.name.trim() || option.id }));
  }

  private async setModel(id: string): Promise<void> {
    const known = this.liveSession()?.modelOptions().map((option) => option.value) ?? this.modelList.map((model) => model.id);
    if (known.length > 0 && !known.includes(id)) throw new Error(`Cursor offers no model "${id}".`);
    this.chosenModel = id;
    const reset = this.chosenEffort !== undefined && !this.efforts().includes(this.chosenEffort);
    if (reset) this.chosenEffort = undefined;
    await this.store.setSelection(this.threadId, this.cwd, { model: id, ...(reset ? { effort: null } : {}) });
  }

  private async setEffort(level: string): Promise<void> {
    if (level === DEFAULT_EFFORT) this.chosenEffort = undefined;
    else {
      const efforts = this.efforts();
      if (efforts.length && !efforts.includes(level)) throw new Error(`This model has no reasoning effort "${level}".`);
      this.chosenEffort = level;
    }
    await this.store.setSelection(this.threadId, this.cwd, { effort: this.chosenEffort ?? null });
  }

  private async setMode(mode: string): Promise<void> {
    if (mode !== PLAN_MODE && mode !== DEFAULT_MODE) throw new Error(`Cursor offers no "${mode}" mode.`);
    this.mode = mode;
    await this.store.setSelection(this.threadId, this.cwd, { mode: mode === DEFAULT_MODE ? null : mode });
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
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Cursor delivery.");
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    validatePreparedPrompt(input.text, prepared, this.bound());
    const clientMessageId = input.identity?.clientMessageId;
    if (clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
      if (existing?.text === prepared.visibleText) return {};
      if (existing) throw new Error(`The Cursor transcript already holds a different message '${clientMessageId}'.`);
    }
    const images = imagesOf(input.attachments);
    const user: UiMessage = {
      id: `cursor-user-${clientMessageId ?? this.now()}`,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(input.identity?.clientTurnId ? { clientTurnId: input.identity.clientTurnId } : {}),
      role: "user",
      text: prepared.visibleText,
      ...(images.length ? { images } : {}),
      timestamp: this.now(),
    };
    this.messages.push(user);
    await this.store.appendMessages(this.threadId, this.cwd, [user]);
    this.deliver(user);
    input.onAdmitted?.(true);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const turn: Turn = { translator: new AcpTurnTranslator(this.now, "cursor"), text: prepared.visibleText, blocks: promptBlocks(prepared.runtimeText, input.attachments), done, finish };
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

  private async runTurn(turn: Turn): Promise<ThreadBackendPromptResult> {
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
      await this.applySelection(live);
      if (turn.status) return {};
      let response: AcpPromptResponse;
      turn.posted = true;
      try {
        response = await live.prompt(turn.blocks);
      } catch (error) {
        if (turn.status) return {};
        const message = error instanceof Error ? error.message : String(error);
        this.report({ type: "notice", message: `Cursor reported an error: ${message}${live.stderr.trim() ? `\n${live.stderr.trim()}` : ""}`, level: "error" });
        this.settle(turn, "error", turn.translator.abandon(), message);
        throw error;
      }
      const events = turn.translator.finish(response);
      const outcome = turn.translator.outcome!;
      this.usage = addUsage(this.usage, outcome.usage);
      await this.store.recordUsage(this.threadId, this.cwd, this.usage);
      const running = live.currentModel();
      if (running && running !== this.observedModel) {
        this.observedModel = running;
        await this.store.setObservedModel(this.threadId, this.cwd, running);
      }
      if (outcome.stopReason === "refusal") this.report({ type: "notice", message: "Cursor declined to continue this turn.", level: "warning" });
      const failure = outcome.cancelled ? undefined : transportFailure(outcome.texts.join("\n"));
      if (failure) {
        this.settle(turn, "error", events, `Cursor could not reach its server: ${failure}`);
        return {};
      }
      this.settle(turn, outcome.cancelled ? "interrupted" : "completed", events);
      return { assistantText: outcome.texts.join("\n\n") };
    } catch (error) {
      if (!turn.status) {
        const message = error instanceof Error ? error.message : String(error);
        this.report({ type: "notice", message: `Cursor could not start: ${message}`, level: "error" });
        this.settle(turn, "error", turn.translator.abandon(), message);
      }
      throw error;
    } finally {
      if (!turn.status) this.settle(turn, "error", turn.translator.abandon());
      await this.persisting;
    }
  }

  private settle(turn: Turn, status: NonNullable<Turn["status"]>, events: ThreadRuntimeEvent[], error?: string): void {
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

  private noteFacts(translator: AcpTurnTranslator): void {
    if (translator.facts.commands) this.commands = translator.facts.commands;
    if (translator.facts.contextUsage) this.contextUsage = translator.facts.contextUsage;
    if (translator.facts.sessionCostUsd !== undefined) this.sessionCostUsd = translator.facts.sessionCostUsd;
  }

  private permissionLevel(): RuntimePermissionLevel {
    return this.options.permissionLevel?.() ?? "full";
  }

  /** Model, effort and mode the thread wants, set on the session where they differ. */
  private async applySelection(live: CursorSessionLike): Promise<void> {
    if (this.chosenModel && live.modelOptions().some((option) => option.value === this.chosenModel)) await live.setModel(this.chosenModel);
    const effort = effortOption(live.configOptions);
    if (effort && this.chosenEffort && configOptionValues(effort).some((entry) => entry.value === this.chosenEffort)) await live.setConfigOption(effort.id, this.chosenEffort);
    const mode = cursorMode(this.mode, this.permissionLevel(), live.modeOptions());
    if (mode) await live.setMode(mode);
  }

  private ensureSession(): Promise<CursorSessionLike> {
    const live = this.liveSession();
    if (live) return Promise.resolve(live);
    this.opening ??= this.openSession().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  /** The CLI, signed in; the stored session loaded (or resumed) once, a gone one started afresh. */
  private async openSession(): Promise<CursorSessionLike> {
    if (this.permissionLevel() === "ask" && !this.options.ask) throw new Error("Cursor cannot ask for approvals on this host; choose read-only or full access.");
    await this.store.ensure(this.threadId, this.cwd, this.options.instance);
    let session: CursorSessionLike | undefined;
    session = await this.options.openSession({
      threadId: this.threadId,
      cwd: this.cwd,
      onUpdate: (update) => this.onUpdate(update),
      onPermission: (request) => this.onPermission(request),
      onElicitation: (request) => answerElicitation(request, this.options.ask, "Cursor"),
      onNotification: (method, params) => this.onExtension(method, params),
      onExit: (error) => this.onExit(session, error),
    });
    try {
      session.handle("cursor/ask_question", (params) => this.askQuestion(params as CursorAskQuestion));
      session.handle("cursor/create_plan", (params) => this.createPlan(params as CursorCreatePlan));
      for (const method of ["cursor/update_todos", "cursor/task", "cursor/generate_image"]) {
        session.handle(method, (params) => { this.onExtension(method, params); return { outcome: { outcome: method === "cursor/task" ? "completed" : method === "cursor/generate_image" ? "generated" : "accepted" } }; });
      }
      await this.restoreSession(session);
      if (session.sessionId && session.sessionId !== this.acpSessionId) {
        this.acpSessionId = session.sessionId;
        await this.store.setAcpSession(this.threadId, this.cwd, session.sessionId);
      }
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    this.live = session;
    return session;
  }

  private async restoreSession(session: CursorSessionLike): Promise<void> {
    const stored = this.acpSessionId;
    const capabilities = session.initialized?.agentCapabilities;
    if (stored && (capabilities?.sessionCapabilities?.resume || capabilities?.loadSession)) {
      try {
        if (capabilities.sessionCapabilities?.resume) await session.resumeSession(stored);
        else await session.loadSession(stored);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/exited|closed/iu.test(message)) throw error;
      }
    }
    if (stored) {
      this.report({ type: "notice", message: "Cursor no longer has this conversation; a new one starts here.", level: "warning" });
      await this.store.setAcpSession(this.threadId, this.cwd, undefined);
      this.acpSessionId = undefined;
    }
    await session.newSession();
  }

  /** Updates outside a posted prompt are a loaded session's replay or session facts; only the facts count. */
  private onUpdate(update: AcpSessionUpdate): void {
    const turn = this.turns[0];
    if (!turn?.posted) {
      const probe = new AcpTurnTranslator(this.now, "cursor");
      if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") probe.push(update);
      this.noteFacts(probe);
      return;
    }
    for (const event of turn.translator.push(update)) this.handleEvent(event);
  }

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    const level = this.permissionLevel();
    if (level === "full") return autoApproval(request) ?? { outcome: { outcome: "cancelled" } };
    if (level === "read-only") {
      const reject = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    const ask = this.options.ask;
    const dialog = permissionDialog(request, { agent: "Cursor" });
    if (!ask || !dialog) return { outcome: { outcome: "cancelled" } };
    return dialog.answerFor(await ask(dialog.prompt).catch((): ExtensionUiAnswer => ({ cancelled: true })));
  }

  private async askQuestion(request: CursorAskQuestion): Promise<CursorAskAnswer> {
    const ask = this.options.ask;
    if (!ask) return { outcome: { outcome: "skipped" } };
    const dialogs = askQuestionDialogs(request);
    const replies: ExtensionUiAnswer[] = [];
    for (const prompt of dialogs.prompts) {
      const reply = await ask(prompt).catch((): ExtensionUiAnswer => ({ cancelled: true }));
      replies.push(reply);
      if ("cancelled" in reply) break;
    }
    return dialogs.answer(replies);
  }

  /** The plan is shown as Plan Kit's card; building it is the user's next prompt, so the agent hears it accepted. */
  private async createPlan(request: CursorCreatePlan): Promise<{ outcome: { outcome: "accepted" } }> {
    const turn = this.turns[0];
    if (turn?.posted) for (const event of turn.translator.reply(planReply(request))) this.handleEvent(event);
    return { outcome: { outcome: "accepted" } };
  }

  private onExtension(method: string, params: unknown): void {
    const turn = this.turns[0];
    const card = extensionCard(method, params);
    if (!turn?.posted || !card) return;
    for (const event of turn.translator.finishedTool(card)) this.handleEvent(event);
  }

  private onExit(session: CursorSessionLike | undefined, error: Error | undefined): void {
    if (!session || this.live !== session) return;
    this.live = undefined;
    if (error) this.report({ type: "notice", message: error.message, level: "error" });
    for (const turn of [...this.turns]) {
      if (turn.posted) this.settle(turn, error ? "error" : "interrupted", turn.translator.abandon(), error?.message);
    }
  }

  private async cancelRunning(turn: Turn): Promise<void> {
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

  private handleEvent(event: ThreadRuntimeEvent): void {
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
    if (this.options.onEvent) {
      this.options.onEvent(message.role === "user" ? { type: "user-message", message } : { type: "assistant-end", message });
      return;
    }
    this.options.onMessage?.(message);
  }

  private report(event: ThreadRuntimeEvent): void {
    this.options.onEvent?.(event);
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
