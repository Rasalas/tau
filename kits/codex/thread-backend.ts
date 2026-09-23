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
  type UiComposerCommand,
  type UiContextUsage,
  type UiMessage,
  type UiModel,
  type UiPromptAttachment,
  type UiSkillDraft,
  type UiThreadUsage,
} from "tau/host-extension";
import { MISSING_THREAD, type CodexAccount, type CodexCollaborationMode, type CodexModel, type CodexPolicy, type CodexThreadInfo, type CodexUserInput } from "./app-server.js";
import { approvalDialog, policyForLevel, refusal } from "./approvals.js";
import { CodexTurnTranslator, codexLimitReset, contextUsage, emptyUsage, threadUsage, type CodexTokenUsage } from "./events.js";
import type { CodexRuntimeAdapter } from "./runtime-adapter.js";
import type { CodexConfiguredModel } from "./config.js";
import type { CodexSessionStore, CodexStoredModel } from "./session-store.js";
import { codexToolsWrite } from "./tools.js";
import { PLAN_MODE } from "./events.js";

/** What the backend needs of a live app-server; `CodexAppServer` is the real one. */
export interface CodexSessionLike {
  readonly closed: boolean;
  readonly stderr: string;
  /** Where the CLI keeps its sessions and login, from the handshake. */
  readonly codexHome?: string;
  account?(): Promise<CodexAccount | undefined>;
  models(): Promise<CodexModel[]>;
  startThread(params: { cwd: string; model?: string; policy: CodexPolicy }): Promise<CodexThreadInfo>;
  resumeThread(params: { threadId: string; cwd: string; model?: string; policy: CodexPolicy }): Promise<CodexThreadInfo>;
  startTurn(params: { threadId: string; input: CodexUserInput[]; policy: CodexPolicy; model?: string; effort?: string; mode?: CodexCollaborationMode }): Promise<string>;
  steerTurn(params: { threadId: string; turnId: string; input: CodexUserInput[] }): Promise<void>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  close(): Promise<void>;
}

export interface CodexSessionInput {
  cwd: string;
  /** The Tau thread the session serves; a probe serves none and gets no Tau tools. */
  threadId?: string;
  /** The only tools the thread keeps, as Pi names them; every tool when absent. */
  tools?: readonly string[];
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, params: unknown): Promise<unknown>;
  onExit(error: Error | undefined): void;
}

export interface CodexThreadBackendOptions {
  adapter: CodexRuntimeAdapter;
  store: CodexSessionStore;
  /** The instance the thread runs on; the default one when absent. */
  instance?: string;
  /** What the instance's `config.toml` sets, which a thread runs on until Codex names its model. */
  configuredModel?(): Promise<CodexConfiguredModel>;
  openSession(input: CodexSessionInput): Promise<CodexSessionLike>;
  /** The account's models as last seen; cheap, read when the thread opens. */
  storedModels?(): Promise<readonly CodexStoredModel[]>;
  /** The account's models before any session of this thread exists; may ask the CLI. */
  models?(): Promise<readonly CodexStoredModel[]>;
  /** What a session reported, so the next thread's picker knows it. */
  onModels?(models: readonly CodexStoredModel[]): void;
  onMessage?(message: UiMessage): void;
  onEvent?(event: ThreadRuntimeEvent): void;
  ask?(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
  permissionLevel?: () => RuntimePermissionLevel;
  /** A thread being created keeps only these tools, as Pi names them. */
  tools?: readonly string[];
  now?(): number;
  timeouts?: { interruptMs?: number };
}

interface Turn {
  translator: CodexTurnTranslator;
  text: string;
  input: CodexUserInput[];
  codexTurnId?: string;
  /** The user stopped it; interrupted as soon as Codex names it. */
  aborted?: boolean;
  status?: "completed" | "interrupted" | "error";
  /** Resolves when Codex reported the turn over, or Tau stopped waiting. */
  completed: Promise<void>;
  complete(): void;
  /** Resolves once the turn settled, however it ended. */
  done: Promise<void>;
  finish(): void;
}

export const MODEL_PROVIDER = "openai";
/** The effort picker's first entry: the model's own default. */
const DEFAULT_EFFORT = "default";

function derivedTitle(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine.replace(/(?:\*\*|__|~~|`)+/gu, "").replace(/[.!?:;]+$/u, "").trim();
  return title ? title.slice(0, 80) : undefined;
}

export function storedModel(model: CodexModel): CodexStoredModel {
  return {
    id: model.id,
    name: model.displayName?.trim() || model.id,
    efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
  };
}

/** Text first, with attached files named by path for Codex to open; images as data URLs. */
export function userInput(text: string, attachments: readonly UiPromptAttachment[] | undefined): CodexUserInput[] {
  const files = (attachments ?? []).flatMap((attachment) => attachment.kind === "file" ? [attachment.path] : []);
  const body = files.length ? `${text}\n\nAttached files:\n${files.map((path) => `- ${path}`).join("\n")}` : text;
  const input: CodexUserInput[] = body.trim() ? [{ type: "text", text: body, text_elements: [] }] : [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind === "image") input.push({ type: "image", url: `data:${attachment.mimeType};base64,${attachment.data}` });
  }
  return input;
}

function imagesOf(attachments: readonly UiPromptAttachment[] | undefined): Array<{ mimeType: string; data: string }> {
  return (attachments ?? []).flatMap((attachment) => attachment.kind === "image" ? [{ mimeType: attachment.mimeType, data: attachment.data }] : []);
}

function wait(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms).unref?.());
}

/**
 * A Codex thread: one `codex app-server` per live thread, the Codex thread
 * started on the first turn and resumed by id after a restart. A prompt is
 * one `turn/start`; a follow-up waits behind it, a steer joins the running
 * turn through `turn/steer`. Codex's approvals and questions go to the
 * workbench's dialog surface.
 */
export class CodexThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind: string;
  readonly runtimeAdapter: CodexRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities;
  private readonly store: CodexSessionStore;
  private readonly now: () => number;
  private messages: UiMessage[] = [];
  private live?: CodexSessionLike;
  private opening?: Promise<CodexSessionLike>;
  private codexThreadId?: string;
  private readonly turns: Turn[] = [];
  private tail: Promise<void> = Promise.resolve();
  private title?: string;
  private titleSource?: ThreadTitleSource;
  private usage: UiThreadUsage = emptyUsage();
  /** The last `account/rateLimits/updated`, for when a usage limit stops a turn. */
  private rateLimits: unknown;
  private context?: UiContextUsage;
  private chosenModel?: string;
  private chosenEffort?: string;
  private mode = DEFAULT_MODE;
  private observedModel?: string;
  /** The effort Codex applies when Tau names none: the thread's own, or the user's config. */
  private observedEffort?: string;
  private modelList: CodexStoredModel[] = [];
  /** The home's `config.toml`, for a thread Codex has not answered yet. */
  private configured: CodexConfiguredModel = {};
  private persisting: Promise<void> = Promise.resolve();
  /** The only tools this thread keeps, from its record. */
  private tools?: string[];

  constructor(readonly threadId: string, readonly cwd: string, private readonly options: CodexThreadBackendOptions) {
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
      // Codex reloads its own thread, so a continuation is an ordinary turn.
      resume: {
        hiddenPrompt: false,
        notice: async (text) => { this.report({ type: "notice", message: text, level: "info" }); },
      },
    };
  }

  get providerSessionId(): string { return this.codexThreadId ?? this.threadId; }

  async start(mode: "create" | "resume"): Promise<void> {
    const instance = this.options.instance;
    let record = mode === "create" ? await this.store.ensure(this.threadId, this.cwd, instance) : await this.store.get(this.threadId) ?? await this.store.ensure(this.threadId, this.cwd, instance);
    if (record.cwd !== this.cwd) throw new Error("This Codex thread belongs to another workspace.");
    if (mode === "create" && this.options.tools) {
      await this.store.setTools(this.threadId, this.cwd, this.options.tools);
      record = { ...record, tools: [...this.options.tools] };
    }
    this.tools = record.tools;
    this.messages = record.messages.map((message, index) => ({
      id: `codex-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    }));
    this.codexThreadId = record.codexThreadId;
    this.title = record.title;
    this.titleSource = record.titleSource;
    if (record.usage) this.usage = { ...record.usage };
    this.chosenModel = record.model;
    this.chosenEffort = record.effort;
    this.mode = record.mode ?? DEFAULT_MODE;
    this.observedModel = record.observedModel;
    this.modelList = [...await this.options.storedModels?.().catch(() => []) ?? []];
    this.configured = await this.options.configuredModel?.().catch(() => ({})) ?? {};
  }

  async transcript(): Promise<UiMessage[]> { return this.messages.map((message) => ({ ...message })); }

  /** Codex's own skills and commands are typed as Codex spells them; Tau offers none of its own. */
  composerCommands(): UiComposerCommand[] { return []; }

  state(): ThreadBackendState {
    const running = this.turns[0];
    return {
      streaming: running !== undefined,
      idle: running === undefined,
      hasMessages: this.messages.length > 0,
      ...(this.title ? { title: this.title } : {}),
      ...(this.titleSource ? { titleSource: this.titleSource } : {}),
      activeTools: [...(running?.translator.running.values() ?? [])].map((tool) => tool.name),
      supportsImageInput: true,
      extensionCount: 0,
    };
  }

  /** The model the next turn runs on: the thread's pick, what Codex last named, `config.toml`, the account's default. */
  private currentModelId(): string | undefined {
    return this.chosenModel ?? this.observedModel ?? this.configured.model;
  }

  private currentModel(): CodexStoredModel | undefined {
    const id = this.currentModelId();
    return id ? this.modelList.find((model) => model.id === id) : this.modelList.find((model) => model.isDefault);
  }

  catalogView(): ThreadCatalogView {
    const info = this.currentModel();
    const id = this.currentModelId() ?? info?.id;
    const applied = this.observedEffort ?? this.configured.effort ?? info?.defaultEffort;
    const fallback = applied ? `${DEFAULT_EFFORT} (${applied})` : DEFAULT_EFFORT;
    return {
      ...(id ? { model: { provider: MODEL_PROVIDER, id, name: info?.name ?? id } } : {}),
      thinkingLevel: this.chosenEffort ?? fallback,
      thinkingLevels: [fallback, ...(info?.efforts ?? [])],
      allTools: [],
      ...(this.usage.turns > 0 ? { usage: { ...this.usage } } : {}),
      ...(this.context ? { contextUsage: { ...this.context } } : {}),
    };
  }

  async models(): Promise<UiModel[]> {
    if (this.modelList.length === 0) this.modelList = [...await this.options.models?.().catch(() => []) ?? []];
    return this.modelList.map((model) => ({ provider: MODEL_PROVIDER, id: model.id, name: model.name }));
  }

  private async setModel(id: string): Promise<void> {
    if (this.modelList.length > 0 && !this.modelList.some((model) => model.id === id)) throw new Error(`Codex offers no model "${id}" to this account.`);
    this.chosenModel = id;
    const efforts = this.currentModel()?.efforts;
    // An effort the new model does not know would be refused on the next turn.
    const resetEffort = this.chosenEffort !== undefined && efforts !== undefined && !efforts.includes(this.chosenEffort);
    if (resetEffort) this.chosenEffort = undefined;
    await this.store.setSelection(this.threadId, this.cwd, { model: id, ...(resetEffort ? { effort: null } : {}) });
  }

  private async setEffort(level: string): Promise<void> {
    if (level.startsWith(DEFAULT_EFFORT)) this.chosenEffort = undefined;
    else {
      const efforts = this.currentModel()?.efforts;
      if (efforts && !efforts.includes(level)) throw new Error(`This model has no reasoning effort "${level}".`);
      this.chosenEffort = level;
    }
    await this.store.setSelection(this.threadId, this.cwd, { effort: this.chosenEffort ?? null });
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
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Codex delivery.");
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    validatePreparedPrompt(input.text, prepared, this.bound());
    const clientMessageId = input.identity?.clientMessageId;
    if (clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
      if (existing?.text === prepared.visibleText) return {};
      if (existing) throw new Error(`The Codex transcript already holds a different message '${clientMessageId}'.`);
    }
    const images = imagesOf(input.attachments);
    const user: UiMessage = {
      id: `codex-user-${clientMessageId ?? this.now()}`,
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
    const codexInput = userInput(prepared.runtimeText, input.attachments);
    const running = this.turns[0];
    if (input.delivery === "steer" && running?.codexTurnId && this.live && !this.live.closed && this.codexThreadId) {
      try {
        await this.live.steerTurn({ threadId: this.codexThreadId, turnId: running.codexTurnId, input: codexInput });
        return {};
      } catch {
        // The turn ended in between; the text becomes the next turn instead.
      }
    }
    let complete!: () => void;
    let finish!: () => void;
    const turn: Turn = {
      translator: new CodexTurnTranslator(this.now),
      text: prepared.visibleText,
      input: codexInput,
      completed: new Promise<void>((resolve) => { complete = resolve; }),
      complete: () => complete(),
      done: new Promise<void>((resolve) => { finish = resolve; }),
      finish: () => finish(),
    };
    this.turns.push(turn);
    if (this.turns.length > 1) this.reportQueue();
    const run = this.tail.then(() => this.runTurn(turn));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runTurn(turn: Turn): Promise<ThreadBackendPromptResult> {
    if (turn.status) return {};
    this.report({ type: "turn-started" });
    this.reportQueue();
    try {
      const live = await this.ensureSession();
      if (turn.aborted) {
        this.settle(turn, "interrupted");
        return {};
      }
      const level = this.permissionLevel();
      const mode = this.collaborationMode();
      const id = await live.startTurn({
        threadId: this.codexThreadId!,
        input: turn.input,
        policy: policyForLevel(level),
        ...(this.chosenModel ? { model: this.chosenModel } : {}),
        ...(this.chosenEffort ? { effort: this.chosenEffort } : {}),
        ...(mode ? { mode } : {}),
      });
      turn.codexTurnId ??= id;
      if (turn.aborted) await this.interrupt(turn);
      await turn.completed;
      const outcome = turn.translator.outcome;
      if (outcome?.status === "failed") this.report({ type: "notice", message: `Codex stopped: ${outcome.error ?? "the turn failed."}`, level: "error" });
      this.usage = { ...this.usage, turns: this.usage.turns + 1 };
      await this.store.recordUsage(this.threadId, this.cwd, this.usage);
      const limit = outcome?.usageLimit ? codexLimitReset(this.rateLimits, this.now()) : undefined;
      this.settle(turn, outcome?.status === "interrupted" ? "interrupted" : outcome?.status === "failed" ? "error" : "completed", outcome?.error,
        outcome?.usageLimit ? { ...(limit ? { resetsAt: limit } : {}) } : undefined);
      return outcome?.texts.length ? { assistantText: outcome.texts.join("\n\n") } : {};
    } catch (error) {
      if (!turn.status) {
        const message = error instanceof Error ? error.message : String(error);
        this.report({ type: "notice", message: `Codex reported an error: ${message}`, level: "error" });
        for (const event of turn.translator.abandon("failed", message)) this.handleEvent(event);
        this.settle(turn, "error", message);
      }
      throw error;
    } finally {
      await this.persisting;
    }
  }

  private settle(turn: Turn, status: NonNullable<Turn["status"]>, error?: string, limit?: { resetsAt?: number }): void {
    if (turn.status) return;
    turn.status = status;
    turn.complete();
    const index = this.turns.indexOf(turn);
    if (index >= 0) this.turns.splice(index, 1);
    this.report({ type: "usage" });
    this.report({ type: "turn-settled", status, ...(status === "error" && error ? { error } : {}), ...(status === "error" && limit ? { limit } : {}) });
    this.reportQueue();
    turn.finish();
  }

  /**
   * Sent with every turn once a model is known: Codex keeps a thread's mode
   * across turns and restarts, so leaving plan has to be said as well.
   */
  private collaborationMode(): CodexCollaborationMode | undefined {
    const model = this.chosenModel ?? this.observedModel ?? this.currentModel()?.id;
    if (!model) return undefined;
    return { mode: this.mode === PLAN_MODE ? "plan" : "default", settings: { model, reasoning_effort: this.chosenEffort ?? null, developer_instructions: null } };
  }

  private async setMode(mode: string): Promise<void> {
    if (mode !== PLAN_MODE && mode !== DEFAULT_MODE) throw new Error(`Codex offers no "${mode}" mode.`);
    this.mode = mode;
    await this.store.setSelection(this.threadId, this.cwd, { mode: mode === DEFAULT_MODE ? null : mode });
  }

  /** The workbench's level, or read-only for a thread left without a tool that writes. */
  private permissionLevel(): RuntimePermissionLevel {
    const level = this.options.permissionLevel?.() ?? "full";
    return this.tools && !codexToolsWrite(this.tools) ? "read-only" : level;
  }

  /** The live app-server, spawned on demand; the stored thread is resumed, a gone one started afresh. */
  private ensureSession(): Promise<CodexSessionLike> {
    if (this.live && !this.live.closed) return Promise.resolve(this.live);
    this.opening ??= this.openSession().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async openSession(): Promise<CodexSessionLike> {
    const level = this.permissionLevel();
    if (level === "ask" && !this.options.ask) throw new Error("Codex cannot ask for approvals on this host; choose read-only or full access.");
    await this.store.ensure(this.threadId, this.cwd, this.options.instance);
    // A process that dies during the handshake exits before `session` is assigned.
    let session: CodexSessionLike | undefined;
    session = await this.options.openSession({
      cwd: this.cwd,
      threadId: this.threadId,
      ...(this.tools ? { tools: this.tools } : {}),
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (error) => this.onExit(session, error),
    });
    try {
      const policy = policyForLevel(level);
      const model = this.chosenModel;
      let info: CodexThreadInfo;
      if (this.codexThreadId) {
        try {
          info = await session.resumeThread({ threadId: this.codexThreadId, cwd: this.cwd, policy, ...(model ? { model } : {}) });
        } catch (error) {
          if (!MISSING_THREAD.test(error instanceof Error ? error.message : String(error))) throw error;
          this.report({ type: "notice", message: "Codex no longer has this conversation; a new one starts here.", level: "warning" });
          info = await session.startThread({ cwd: this.cwd, policy, ...(model ? { model } : {}) });
        }
      } else {
        info = await session.startThread({ cwd: this.cwd, policy, ...(model ? { model } : {}) });
      }
      if (info.thread.id !== this.codexThreadId) {
        this.codexThreadId = info.thread.id;
        await this.store.setCodexThread(this.threadId, this.cwd, info.thread.id);
      }
      if (info.reasoningEffort) this.observedEffort = info.reasoningEffort;
      if (info.model && info.model !== this.observedModel) {
        this.observedModel = info.model;
        await this.store.setObservedModel(this.threadId, this.cwd, info.model);
      }
      const models = (await session.models().catch(() => [])).map(storedModel);
      if (models.length > 0) {
        this.modelList = models;
        this.options.onModels?.(models);
      }
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    this.live = session;
    return session;
  }

  private onNotification(method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown>;
    if (typeof params.threadId === "string" && this.codexThreadId && params.threadId !== this.codexThreadId) return;
    if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage as CodexTokenUsage | undefined;
      if (!usage?.total) return;
      this.usage = threadUsage(usage, this.usage.turns);
      this.context = contextUsage(usage) ?? this.context;
      this.report({ type: "usage" });
      return;
    }
    if (method === "account/rateLimits/updated") {
      this.rateLimits = params.rateLimits;
      return;
    }
    if (method === "error") {
      const error = params.error as { message?: string } | undefined;
      const message = error?.message?.trim() || "Codex reported an error.";
      this.report(params.willRetry ? { type: "notice", message: `Codex is retrying: ${message}`, level: "warning" } : { type: "notice", message, level: "error" });
      return;
    }
    const turn = this.turns[0];
    if (!turn) return;
    const turnId = typeof params.turnId === "string" ? params.turnId : (params.turn as { id?: string } | undefined)?.id;
    if (method === "turn/started" && turnId) turn.codexTurnId ??= turnId;
    if (turnId && turn.codexTurnId && turnId !== turn.codexTurnId) return;
    for (const event of turn.translator.push(method, params)) this.handleEvent(event);
    if (method === "turn/completed") turn.complete();
  }

  private async onRequest(method: string, raw: unknown): Promise<unknown> {
    const params = (raw ?? {}) as Record<string, unknown>;
    const turn = this.turns[0];
    const dialog = approvalDialog(method, params, (itemId) => turn?.translator.changes.get(itemId) ?? []);
    if (!dialog) {
      const answer = refusal(method);
      if (answer !== undefined) return answer;
      throw new Error(`Tau does not answer Codex's ${method}.`);
    }
    const ask = this.options.ask;
    const answers: ExtensionUiAnswer[] = [];
    if (ask) {
      for (const prompt of dialog.prompts) {
        const answer = await ask(prompt);
        answers.push(answer);
        if ("cancelled" in answer) break;
      }
    }
    return dialog.resultFor(answers);
  }

  /** Only the live session's exit settles a turn; one that dies while opening fails the open instead. */
  private onExit(session: CodexSessionLike | undefined, error: Error | undefined): void {
    if (!session || this.live !== session) return;
    this.live = undefined;
    const turn = this.turns[0];
    if (!error && !turn) return;
    if (error) this.report({ type: "notice", message: error.message, level: "error" });
    if (turn && !turn.translator.outcome) {
      for (const event of turn.translator.abandon("failed", error?.message ?? "Codex exited.")) this.handleEvent(event);
      turn.complete();
    }
  }

  async abort(): Promise<void> {
    const turn = this.turns[0];
    if (!turn) return;
    turn.aborted = true;
    // Before Codex named the turn there is nothing to interrupt; `runTurn` does it once it can.
    if (turn.codexTurnId) await this.interrupt(turn);
    await turn.done;
  }

  private async interrupt(turn: Turn): Promise<void> {
    const live = this.live;
    if (live && !live.closed && this.codexThreadId && turn.codexTurnId) await live.interruptTurn(this.codexThreadId, turn.codexTurnId).catch(() => undefined);
    const stopped = await Promise.race([turn.completed.then(() => true), wait(this.options.timeouts?.interruptMs ?? 10_000)]);
    if (stopped) return;
    // Codex did not confirm the interrupt; the process goes with the turn.
    for (const event of turn.translator.abandon("interrupted")) this.handleEvent(event);
    turn.complete();
    if (this.live === live) this.live = undefined;
    await live?.close().catch(() => undefined);
  }

  private handleEvent(event: ThreadRuntimeEvent): void {
    if (event.type === "assistant-end") {
      this.messages.push(event.message);
      const message = event.message;
      this.persisting = this.persisting.then(() => this.store.appendMessages(this.threadId, this.cwd, [message])).catch(() => undefined);
      this.deliver(message);
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
