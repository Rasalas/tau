import { pathToFileURL } from "node:url";
import {
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
  type UiPromptAttachment,
  type UiSkillDraft,
  type UiThreadUsage,
} from "tau/host-extension";
import type { AcpContentBlock, AcpElicitationAnswer, AcpElicitationRequest, AcpInitializeResult, AcpPermissionRequest, AcpPermissionResponse, AcpSelectOption, AcpSessionSetup } from "./acp-session.js";
import { answerElicitation, modeForLevel, permissionDialog } from "./approvals.js";
import { AcpTurnTranslator, addUsage, type AcpCommand, type AcpPromptResponse, type AcpSessionUpdate } from "./events.js";
import type { AuthorizationLink } from "./profile.js";
import type { AntigravityRuntimeAdapter } from "./runtime-adapter.js";
import { AntigravitySessionStore } from "./session-store.js";

/** What the backend needs of a live ACP session; `AntigravitySession` is the real one, tests script one. */
export interface AntigravitySessionLike {
  readonly closed: boolean;
  readonly sessionId: string | undefined;
  readonly modeId: string | undefined;
  readonly initialized?: AcpInitializeResult;
  readonly stderr: string;
  newSession(): Promise<AcpSessionSetup>;
  resumeSession(sessionId: string): Promise<AcpSessionSetup>;
  /** Clears the agent's own Google credentials; only the sign-out path uses it. */
  logout?(): Promise<void>;
  modelOptions(): AcpSelectOption[];
  modeOptions(): AcpSelectOption[];
  currentModel(): string | undefined;
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  prompt(blocks: readonly AcpContentBlock[], signal?: AbortSignal): Promise<AcpPromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface AntigravitySessionInput {
  threadId: string;
  cwd: string;
  /** False shakes hands without signing in, for a sign-out. */
  authenticate?: boolean;
  /** Ends a session that is still signing in. */
  signal?: AbortSignal;
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
  onElicitation?(request: AcpElicitationRequest): Promise<AcpElicitationAnswer>;
  onSignIn(link: AuthorizationLink): void;
  onExit(error: Error | undefined): void;
}

export interface AntigravityThreadBackendOptions {
  /** Where the thread's tool cards are kept across restarts. */
  activity?: TurnActivityStore;
  adapter: AntigravityRuntimeAdapter;
  store: AntigravitySessionStore;
  /** Spawns and shakes hands with the agent; the backend creates or resumes the session itself. */
  openSession(input: AntigravitySessionInput): Promise<AntigravitySessionLike>;
  onMessage?(message: UiMessage): void;
  onEvent?(event: ThreadRuntimeEvent): void;
  ask?(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
  /** The link the agent wants opened for Google's sign-in. */
  onSignIn?(link: AuthorizationLink, threadId: string): void;
  /** Models to list before a session exists. */
  cachedModels?(): Promise<AcpSelectOption[]>;
  /** What the agent offers this account, reported once a session exists so the next start knows it. */
  onModels?(models: readonly AcpSelectOption[]): void;
  projectName: string;
  branch?: string;
  permissionLevel?: () => RuntimePermissionLevel;
  now?(): number;
}

interface Turn {
  translator: AcpTurnTranslator;
  text: string;
  blocks: AcpContentBlock[];
  status?: "completed" | "interrupted" | "error";
  /** Resolves when the turn has settled, however it ended. */
  done: Promise<void>;
  finish(): void;
}

export const MODEL_PROVIDER = "google";
const RESUME_MISSING = /(?:session|conversation)[^\n]*(?:not found|does not exist|unknown|missing|invalid|expired)|(?:no|cannot|could not)\s+(?:find\s+|load\s+|resume\s+)?(?:the\s+)?(?:session|conversation)/iu;

function derivedTitle(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine.replace(/(?:\*\*|__|~~|`)+/gu, "").replace(/[.!?:;]+$/u, "").trim();
  return title ? title.slice(0, 80) : undefined;
}

/**
 * Text first, then images as native content and files as links the agent
 * opens itself; the agent reads a slash command from the leading text.
 */
export function promptBlocks(text: string, attachments: readonly UiPromptAttachment[] | undefined): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = text.trim() ? [{ type: "text", text }] : [];
  for (const attachment of attachments ?? []) {
    blocks.push(attachment.kind === "image"
      ? { type: "image", data: attachment.data, mimeType: attachment.mimeType }
      : { type: "resource_link", uri: pathToFileURL(attachment.path).href, name: attachment.name, mimeType: attachment.mimeType });
  }
  return blocks;
}

/** The capability over the kit's store; the agent's own history is not read back. */
function activityHistory(threadId: string, store: TurnActivityStore | undefined): Pick<ThreadBackendCapabilities, "activityHistory"> {
  return store ? { activityHistory: { load: () => store.load(threadId), save: (entry) => store.save(threadId, entry) } } : {};
}

function imagesOf(attachments: readonly UiPromptAttachment[] | undefined): Array<{ mimeType: string; data: string }> {
  return (attachments ?? []).flatMap((attachment) => attachment.kind === "image" ? [{ mimeType: attachment.mimeType, data: attachment.data }] : []);
}

/**
 * Antigravity's complete thread owner: one ACP session per live thread,
 * created on the first turn and resumed by id after a restart. A turn is one
 * `session/prompt`; follow-ups wait behind it, a steer cancels it and takes
 * its place. The agent's questions and approvals go to the workbench.
 */
export class AntigravityThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind = "antigravity" as const;
  readonly runtimeAdapter: AntigravityRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities;
  private readonly store: AntigravitySessionStore;
  private readonly options: AntigravityThreadBackendOptions;
  private readonly now: () => number;
  private record?: Awaited<ReturnType<AntigravitySessionStore["get"]>>;
  private messages: UiMessage[] = [];
  private live?: AntigravitySessionLike;
  private opening?: Promise<AntigravitySessionLike>;
  private readonly turns: Turn[] = [];
  private tail: Promise<void> = Promise.resolve();
  private title?: string;
  private titleSource?: ThreadTitleSource;
  private usage: UiThreadUsage = AcpTurnTranslator.emptyUsage();
  private contextUsage?: UiContextUsage;
  private sessionCostUsd?: number;
  private chosenModel?: string;
  /** The model the thread last ran on, for the picker before a session exists. */
  private observedModel?: string;
  private commands: AcpCommand[] = [];
  /** The account's models by id, so a thread can name its model without a live session. */
  private modelNames = new Map<string, string>();
  private appliedLevel?: RuntimePermissionLevel;
  /** Transcript writes in flight; a turn waits for them before it reports back. */
  private persisting: Promise<void> = Promise.resolve();

  constructor(readonly threadId: string, readonly cwd: string, options: AntigravityThreadBackendOptions) {
    this.options = options;
    this.runtimeAdapter = options.adapter;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.capabilities = {
      catalogWrite: {
        setModel: (_provider, id) => this.setModel(id),
        setThinkingLevel: async () => { throw new Error("Antigravity chooses effort with the model; pick a model variant instead."); },
      },
      // The agent reloads the stored ACP session itself, so a continuation is
      // an ordinary turn; the protocol has no message kind the transcript hides.
      resume: {
        hiddenPrompt: false,
        notice: async (text) => { this.report({ type: "notice", message: text, level: "info" }); },
      },
      ...activityHistory(threadId, options.activity),
    };
  }

  get providerSessionId(): string { return this.record?.acpSessionId ?? this.threadId; }

  async start(mode: "create" | "resume"): Promise<void> {
    this.record = mode === "create"
      ? await this.store.ensure(this.threadId, this.cwd)
      : await this.store.get(this.threadId) ?? await this.store.ensure(this.threadId, this.cwd);
    if (this.record.cwd !== this.cwd) throw new Error("Antigravity session belongs to another workspace.");
    this.messages = this.record.messages.map((message, index) => ({
      id: message.id ?? `antigravity-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    }));
    this.title = this.record.title;
    this.titleSource = this.record.titleSource;
    if (this.record.usage) this.usage = { ...this.record.usage };
    this.chosenModel = this.record.model;
    this.observedModel = this.record.observedModel;
    this.rememberModels(await this.options.cachedModels?.() ?? []);
  }

  private rememberModels(models: readonly AcpSelectOption[]): void {
    for (const model of models) this.modelNames.set(model.value, model.name.trim() || model.value);
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

  catalogView(): ThreadCatalogView {
    const live = this.live && !this.live.closed ? this.live : undefined;
    const current = live?.currentModel() ?? this.chosenModel ?? this.observedModel;
    const named = live?.modelOptions().find((option) => option.value === current) ?? (current ? { name: this.modelNames.get(current) } : undefined);
    const usage = this.usage.turns > 0 ? { ...this.usage, ...(this.sessionCostUsd !== undefined ? { costUsd: this.sessionCostUsd } : {}) } : undefined;
    return {
      ...(current ? { model: { provider: MODEL_PROVIDER, id: current, name: named?.name ?? current } } : {}),
      thinkingLevel: "default",
      thinkingLevels: [],
      allTools: [],
      ...(usage ? { usage } : {}),
      ...(this.contextUsage ? { contextUsage: { ...this.contextUsage } } : {}),
    };
  }

  async models(): Promise<UiModel[]> {
    const live = this.live && !this.live.closed ? this.live : undefined;
    const options = live ? live.modelOptions() : await this.options.cachedModels?.() ?? [];
    return options.map((option) => ({ provider: MODEL_PROVIDER, id: option.value, name: option.name.trim() || option.value }));
  }

  private async setModel(id: string): Promise<void> {
    const live = this.live && !this.live.closed ? this.live : undefined;
    if (live) await live.setModel(id);
    this.chosenModel = id;
    await this.store.setModel(this.threadId, this.cwd, id);
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
    validatePreparedPrompt(text, result, { backendKind: this.kind, threadId: this.threadId, providerSessionId: this.providerSessionId, runtimeCapabilities: this.runtimeAdapter.capabilities, commands });
    return result;
  }

  async prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult> {
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Antigravity delivery.");
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    validatePreparedPrompt(input.text, prepared, { backendKind: this.kind, threadId: this.threadId, providerSessionId: this.providerSessionId, runtimeCapabilities: this.runtimeAdapter.capabilities, commands: this.composerCommands() });
    const clientMessageId = input.identity?.clientMessageId;
    if (clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
      if (existing) {
        if (existing.text === prepared.visibleText) return {};
        throw new Error(`Antigravity transcript already contains a conflicting message id '${clientMessageId}'.`);
      }
    }
    const user: UiMessage = {
      id: `antigravity-user-${clientMessageId ?? this.now()}`,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(input.identity?.clientTurnId ? { clientTurnId: input.identity.clientTurnId } : {}),
      role: "user",
      text: prepared.visibleText,
      ...(imagesOf(input.attachments).length ? { images: imagesOf(input.attachments) } : {}),
      timestamp: this.now(),
    };
    this.messages.push(user);
    await this.store.appendMessages(this.threadId, this.cwd, [user]);
    // No title is stored here: the thread index names an unnamed thread after
    // its first message, and a stored name would stop the title generator.
    this.deliver(user);
    input.onAdmitted?.(true);
    const blocks = promptBlocks(prepared.runtimeText, input.attachments);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const turn: Turn = { translator: new AcpTurnTranslator(this.now), text: prepared.visibleText, blocks, done, finish };
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
      let response: AcpPromptResponse;
      try {
        response = await live.prompt(turn.blocks);
      } catch (error) {
        if (turn.status) return {};
        const message = error instanceof Error ? error.message : String(error);
        this.report({ type: "notice", message: `Antigravity reported an error: ${message}${live.stderr.trim() ? `\n${live.stderr.trim()}` : ""}`, level: "error" });
        this.settle(turn, "error", turn.translator.abandon());
        throw error;
      }
      const events = turn.translator.finish(response);
      const outcome = turn.translator.outcome!;
      this.usage = addUsage(this.usage, outcome.usage);
      await this.store.recordUsage(this.threadId, this.cwd, this.usage);
      if (outcome.stopReason === "refusal") this.report({ type: "notice", message: "Antigravity declined to continue this turn.", level: "warning" });
      this.settle(turn, outcome.cancelled ? "interrupted" : "completed", events);
      return { assistantText: outcome.texts.join("\n\n") };
    } finally {
      if (!turn.status) this.settle(turn, "error", turn.translator.abandon());
      await this.persisting;
    }
  }

  private settle(turn: Turn, status: NonNullable<Turn["status"]>, events: ThreadRuntimeEvent[]): void {
    if (turn.status) return;
    for (const event of events) this.handleEvent(event);
    turn.status = status;
    const index = this.turns.indexOf(turn);
    if (index >= 0) this.turns.splice(index, 1);
    this.noteFacts(turn.translator);
    this.report({ type: "usage" });
    this.report({ type: "turn-settled", status });
    this.reportQueue();
    turn.finish();
  }

  private noteFacts(translator: AcpTurnTranslator): void {
    if (translator.facts.commands) this.commands = translator.facts.commands;
    if (translator.facts.contextUsage) this.contextUsage = translator.facts.contextUsage;
    if (translator.facts.sessionCostUsd !== undefined) this.sessionCostUsd = translator.facts.sessionCostUsd;
  }

  /** The live session, spawned on demand; the stored id is resumed once and a gone session started afresh. */
  private async ensureSession(): Promise<AntigravitySessionLike> {
    if (this.live && !this.live.closed) {
      await this.applyLevel(this.live);
      return this.live;
    }
    if (!this.opening) {
      this.opening = this.openSession().finally(() => { this.opening = undefined; });
    }
    return this.opening;
  }

  private async openSession(): Promise<AntigravitySessionLike> {
    const record = await this.store.ensure(this.threadId, this.cwd);
    this.record = record;
    const session = await this.options.openSession({
      threadId: this.threadId,
      cwd: this.cwd,
      onUpdate: (update) => this.onUpdate(update),
      onPermission: (request) => this.onPermission(request),
      onElicitation: (request) => answerElicitation(request, this.options.ask),
      onSignIn: (link) => {
        this.report({ type: "notice", message: "Antigravity needs a Google sign-in. Tau opened the link in your browser; finish it there and the turn continues.", level: "info" });
        this.options.onSignIn?.(link, this.threadId);
      },
      onExit: (error) => this.onExit(session, error),
    });
    try {
      if (record.acpSessionId) {
        try {
          await session.resumeSession(record.acpSessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!RESUME_MISSING.test(message) && !/resum/iu.test(message)) throw error;
          this.report({ type: "notice", message: "Antigravity no longer has this conversation; a new one starts here.", level: "warning" });
          await this.store.clearAcpSession(this.threadId, this.cwd);
          await session.newSession();
        }
      } else {
        await session.newSession();
      }
      if (session.sessionId) await this.store.setAcpSession(this.threadId, this.cwd, session.sessionId);
      const models = session.modelOptions();
      if (models.length > 0) {
        this.rememberModels(models);
        this.options.onModels?.(models);
      }
      const running = session.currentModel();
      if (running && running !== this.observedModel) {
        this.observedModel = running;
        await this.store.setObservedModel(this.threadId, this.cwd, running);
      }
      this.record = await this.store.get(this.threadId);
      if (this.chosenModel && session.modelOptions().some((option) => option.value === this.chosenModel)) await session.setModel(this.chosenModel);
      this.appliedLevel = undefined;
      await this.applyLevel(session);
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    this.live = session;
    return session;
  }

  /** The access level as a session mode, applied when it changed. */
  private async applyLevel(session: AntigravitySessionLike): Promise<void> {
    const level = this.options.permissionLevel?.() ?? "full";
    if (level === "ask" && !this.options.ask) throw new Error("Antigravity cannot ask for approvals on this host; choose read-only or full access.");
    if (this.appliedLevel === level) return;
    const mode = modeForLevel(level, session.modeOptions());
    if (mode) await session.setMode(mode);
    this.appliedLevel = level;
  }

  private onUpdate(update: AcpSessionUpdate): void {
    const turn = this.turns[0];
    if (!turn) {
      const probe = new AcpTurnTranslator(this.now);
      probe.push(update);
      this.noteFacts(probe);
      return;
    }
    for (const event of turn.translator.push(update)) this.handleEvent(event);
  }

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    const ask = this.options.ask;
    const dialog = permissionDialog(request);
    if (!ask || !dialog) return { outcome: { outcome: "cancelled" } };
    return dialog.answerFor(await ask(dialog.prompt));
  }

  private onExit(session: AntigravitySessionLike, error: Error | undefined): void {
    if (this.live === session) this.live = undefined;
    if (error) this.report({ type: "notice", message: error.message, level: "error" });
    for (const turn of [...this.turns]) this.settle(turn, error ? "error" : "interrupted", turn.translator.abandon());
  }

  private async cancelRunning(turn: Turn): Promise<void> {
    const live = this.live;
    if (live && !live.closed) await live.cancel().catch(() => undefined);
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
