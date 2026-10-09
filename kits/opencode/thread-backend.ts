import {
  executionPolicyRefusal,
  DEFAULT_THREAD_MODE as DEFAULT_MODE,
  clientMessageFingerprint,
  knownSkillNames,
  prepareSkillPrompt,
  validatePreparedPrompt,
  type BackendPrompt,
  type ExtensionUiAnswer,
  type HostExecutionPolicy,
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
import { permissionDialog, questionDialogs, rulesForLevel, type PermissionRequest, type QuestionInfo } from "./approvals.js";
import { DEFAULT_VARIANT, thinkingLevels } from "./catalog.js";
import { OpenCodeHttpError, type OpenCodeEvent, type OpenCodeInputPart, type OpenCodePromptBody, type OpenCodeSession } from "./client.js";
import { OpenCodeTurnTranslator, emptyUsage, sessionUsage, stepContext } from "./events.js";
import type { OpenCodeRuntimeAdapter } from "./runtime-adapter.js";
import type { OpenCodeServerHandle } from "./server.js";
import type { OpenCodeModelRef, OpenCodeSessionStore, OpenCodeStoredModel } from "./session-store.js";
import { openCodeToolSwitches, openCodeToolsWrite } from "./tools.js";

/** What a thread's server connection needs from the kit. */
export interface OpenCodeConnectInput {
  cwd: string;
  /** The Tau thread the server serves; a probe serves none and gets no Tau tools. */
  threadId?: string;
  tools?: readonly string[];
  onExit(error: Error | undefined): void;
}

export interface OpenCodeThreadBackendOptions {
  activity?: TurnActivityStore;
  adapter: OpenCodeRuntimeAdapter;
  store: OpenCodeSessionStore;
  instance?: string;
  /** A server for this thread: one Tau starts, or the instance's own. */
  connect(input: OpenCodeConnectInput): Promise<OpenCodeServerHandle>;
  /** The model OpenCode's config names, which a thread runs on until one is picked. */
  configuredModel?(): Promise<OpenCodeModelRef | undefined>;
  /** The providers' models as last seen; cheap, read when the thread opens. */
  storedModels?(): Promise<readonly OpenCodeStoredModel[]>;
  /** The providers' models before this thread has a server; may start one. */
  models?(): Promise<readonly OpenCodeStoredModel[]>;
  onMessage?(message: UiMessage): void;
  onEvent?(event: ThreadRuntimeEvent): void;
  ask?(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
  permissionLevel?: () => RuntimePermissionLevel;
  /**
   * What the thread's project lets its commands reach (API 1.14.0). OpenCode
   * has no sandbox Tau can set, so a limited project's prompt is refused.
   */
  executionPolicy?(): Promise<HostExecutionPolicy>;
  tools?: readonly string[];
  now?(): number;
  timeouts?: { interruptMs?: number };
}

interface Turn {
  translator: OpenCodeTurnTranslator;
  text: string;
  parts: OpenCodeInputPart[];
  aborted?: boolean;
  /** The prompt is on its way to OpenCode; events are this turn's and abort has something to stop. */
  posted?: boolean;
  status?: "completed" | "interrupted" | "error";
  completed: Promise<void>;
  complete(): void;
  done: Promise<void>;
  finish(): void;
}

interface Live {
  server: OpenCodeServerHandle;
  close(): void;
}

/** Tau's name for OpenCode's plan agent, and the agent's own name. */
export const PLAN_MODE = "plan";
/** A plan reaches the transcript as a block Plan Kit draws as a card. */
const PLAN_SYSTEM = "You are in plan mode: explore and ask, change nothing. When the plan is ready, write it once inside a <proposed_plan> block.";

function derivedTitle(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine.replace(/(?:\*\*|__|~~|`)+/gu, "").replace(/[.!?:;]+$/u, "").trim();
  return title ? title.slice(0, 80) : undefined;
}

/** Text first, with attached files named by path for OpenCode to open; images as data URLs. */
export function promptParts(text: string, attachments: readonly UiPromptAttachment[] | undefined): OpenCodeInputPart[] {
  const files = (attachments ?? []).flatMap((attachment) => attachment.kind === "file" ? [attachment.path] : []);
  const body = files.length ? `${text}\n\nAttached files:\n${files.map((path) => `- ${path}`).join("\n")}` : text;
  const parts: OpenCodeInputPart[] = body.trim() ? [{ type: "text", text: body }] : [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind === "image") parts.push({ type: "file", mime: attachment.mimeType, url: `data:${attachment.mimeType};base64,${attachment.data}`, ...(attachment.name ? { filename: attachment.name } : {}) });
  }
  return parts;
}

function imagesOf(attachments: readonly UiPromptAttachment[] | undefined): Array<{ mimeType: string; data: string }> {
  return (attachments ?? []).flatMap((attachment) => attachment.kind === "image" ? [{ mimeType: attachment.mimeType, data: attachment.data }] : []);
}

function activityHistory(threadId: string, store: TurnActivityStore | undefined): Pick<ThreadBackendCapabilities, "activityHistory"> {
  return store ? { activityHistory: { load: () => store.load(threadId), save: (entry) => store.save(threadId, entry) } } : {};
}

function wait(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms).unref?.());
}

function missing(error: unknown): boolean {
  return error instanceof OpenCodeHttpError && error.status === 404;
}

/** The session an event is about: `sessionID`, or a session event's own id. */
function sessionOf(event: OpenCodeEvent): string | undefined {
  const id = event.properties.sessionID ?? (event.properties.info as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * An OpenCode thread: one OpenCode session, on a server Tau starts for the
 * thread (or the instance's own server), created on the first turn and
 * resumed by id after a restart. A prompt is one `prompt_async`; the turn is
 * read from the event stream until the session is idle. A steer joins the
 * running turn (OpenCode queues it); a follow-up waits behind it.
 */
export class OpenCodeThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind: string;
  readonly runtimeAdapter: OpenCodeRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities;
  private readonly store: OpenCodeSessionStore;
  private readonly now: () => number;
  private messages: UiMessage[] = [];
  private live?: Live;
  private opening?: Promise<Live>;
  private sessionId?: string;
  /** Sub-agent sessions OpenCode started under this thread's; their questions are the thread's. */
  private readonly children = new Set<string>();
  private readonly turns: Turn[] = [];
  private tail: Promise<void> = Promise.resolve();
  private title?: string;
  private titleSource?: ThreadTitleSource;
  private nativeTitle?: string;
  private usage: UiThreadUsage = emptyUsage();
  private context?: UiContextUsage;
  private chosenModel?: OpenCodeModelRef;
  private chosenVariant?: string;
  private mode = DEFAULT_MODE;
  private observedModel?: OpenCodeModelRef;
  private configured?: OpenCodeModelRef;
  private modelList: OpenCodeStoredModel[] = [];
  /** The access level the session's rules were last set for. */
  private rulesLevel?: RuntimePermissionLevel;
  private persisting: Promise<void> = Promise.resolve();
  private tools?: string[];

  constructor(readonly threadId: string, readonly cwd: string, private readonly options: OpenCodeThreadBackendOptions) {
    this.runtimeAdapter = options.adapter;
    this.kind = options.adapter.id;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.capabilities = {
      titles: { title: async () => this.nativeTitle },
      catalogWrite: {
        setModel: (provider, id) => this.setModel(provider, id),
        setThinkingLevel: (level) => this.setVariant(level),
      },
      mode: {
        modes: () => [PLAN_MODE],
        current: () => this.mode,
        set: (mode) => this.setMode(mode),
      },
      // OpenCode keeps the session, so a continuation is an ordinary turn.
      resume: {
        hiddenPrompt: false,
        notice: async (text) => { this.report({ type: "notice", message: text, level: "info" }); },
      },
      ...activityHistory(threadId, options.activity),
    };
  }

  get providerSessionId(): string { return this.sessionId ?? this.threadId; }

  async start(mode: "create" | "resume"): Promise<void> {
    const instance = this.options.instance;
    let record = mode === "create" ? await this.store.ensure(this.threadId, this.cwd, instance) : await this.store.get(this.threadId) ?? await this.store.ensure(this.threadId, this.cwd, instance);
    if (record.cwd !== this.cwd) throw new Error("This OpenCode thread belongs to another workspace.");
    if (mode === "create" && this.options.tools) {
      await this.store.setTools(this.threadId, this.cwd, this.options.tools);
      record = { ...record, tools: [...this.options.tools] };
    }
    this.tools = record.tools;
    this.messages = record.messages.map((message, index) => ({
      id: message.id ?? `opencode-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    }));
    this.sessionId = record.sessionId;
    this.title = record.title;
    this.titleSource = record.titleSource;
    if (record.usage) this.usage = { ...record.usage };
    this.chosenModel = record.model;
    this.chosenVariant = record.variant;
    this.mode = record.mode ?? DEFAULT_MODE;
    this.observedModel = record.observedModel;
    this.modelList = [...await this.options.storedModels?.().catch(() => []) ?? []];
    this.configured = await this.options.configuredModel?.().catch(() => undefined);
  }

  async transcript(): Promise<UiMessage[]> { return this.messages.map((message) => ({ ...message })); }

  /** OpenCode's own commands are typed as OpenCode spells them; Tau offers none of its own. */
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

  /** The model the next turn runs on: the thread's pick, what OpenCode last ran, the config's. */
  private currentModelRef(): OpenCodeModelRef | undefined {
    return this.chosenModel ?? this.observedModel ?? this.configured;
  }

  private currentModel(): OpenCodeStoredModel | undefined {
    const ref = this.currentModelRef();
    return ref ? this.modelList.find((model) => model.provider === ref.provider && model.id === ref.id) : undefined;
  }

  catalogView(): ThreadCatalogView {
    const ref = this.currentModelRef();
    const info = this.currentModel();
    return {
      ...(ref ? { model: { provider: ref.provider, id: ref.id, name: info?.name ?? ref.id } } : {}),
      thinkingLevel: this.chosenVariant ?? DEFAULT_VARIANT,
      thinkingLevels: thinkingLevels(info?.variants ?? []),
      allTools: [],
      ...(this.usage.turns > 0 ? { usage: { ...this.usage } } : {}),
      ...(this.context ? { contextUsage: { ...this.context } } : {}),
    };
  }

  async models(): Promise<UiModel[]> {
    if (this.modelList.length === 0) this.modelList = [...await this.options.models?.().catch(() => []) ?? []];
    return this.modelList.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
  }

  private async setModel(provider: string, id: string): Promise<void> {
    if (this.modelList.length > 0 && !this.modelList.some((model) => model.provider === provider && model.id === id)) throw new Error(`OpenCode offers no model "${provider}/${id}".`);
    this.chosenModel = { provider, id };
    const variants = this.currentModel()?.variants;
    const resetVariant = this.chosenVariant !== undefined && variants !== undefined && !variants.includes(this.chosenVariant);
    if (resetVariant) this.chosenVariant = undefined;
    await this.store.setSelection(this.threadId, this.cwd, { model: this.chosenModel, ...(resetVariant ? { variant: null } : {}) });
  }

  private async setVariant(level: string): Promise<void> {
    if (level === DEFAULT_VARIANT) this.chosenVariant = undefined;
    else {
      const variants = this.currentModel()?.variants;
      if (variants && !variants.includes(level)) throw new Error(`This model has no reasoning effort "${level}".`);
      this.chosenVariant = level;
    }
    await this.store.setSelection(this.threadId, this.cwd, { variant: this.chosenVariant ?? null });
  }

  private async setMode(mode: string): Promise<void> {
    if (mode !== PLAN_MODE && mode !== DEFAULT_MODE) throw new Error(`OpenCode offers no "${mode}" mode.`);
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
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported OpenCode delivery.");
    const refusal = executionPolicyRefusal(await this.options.executionPolicy?.(), "OpenCode");
    if (refusal) throw new Error(refusal);
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    validatePreparedPrompt(input.text, prepared, this.bound());
    const clientMessageId = input.identity?.clientMessageId;
    if (clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
      if (existing?.text === prepared.visibleText) return {};
      if (existing) throw new Error(`The OpenCode transcript already holds a different message '${clientMessageId}'.`);
    }
    const images = imagesOf(input.attachments);
    const user: UiMessage = {
      id: `opencode-user-${clientMessageId ?? this.now()}`,
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
    const parts = promptParts(prepared.runtimeText, input.attachments);
    const running = this.turns[0];
    // OpenCode queues a prompt that arrives while it works and answers it in the same run.
    if (input.delivery === "steer" && running?.posted && !running.status && this.live && !this.live.server.closed && this.sessionId) {
      try {
        await this.live.server.client.promptAsync(this.cwd, this.sessionId, this.promptBody(parts));
        return {};
      } catch {
        // The turn ended in between; the text becomes the next turn instead.
      }
    }
    let complete!: () => void;
    let finish!: () => void;
    const turn: Turn = {
      translator: new OpenCodeTurnTranslator(this.now),
      text: prepared.visibleText,
      parts,
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

  private promptBody(parts: OpenCodeInputPart[]): OpenCodePromptBody {
    // The model the picker shows is the one that runs, also for a session OpenCode started anew.
    const model = this.currentModelRef();
    const plan = this.mode === PLAN_MODE;
    return {
      parts,
      ...(model ? { model: { providerID: model.provider, modelID: model.id } } : {}),
      ...(this.chosenVariant ? { variant: this.chosenVariant } : {}),
      ...(plan ? { agent: PLAN_MODE, system: PLAN_SYSTEM } : {}),
      ...(this.tools ? { tools: openCodeToolSwitches(this.tools) } : {}),
    };
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
      await this.applyRules(live);
      // Events may arrive before the answer does; from here on they are this turn's.
      turn.posted = true;
      await live.server.client.promptAsync(this.cwd, this.sessionId!, this.promptBody(turn.parts));
      if (turn.aborted) await this.interrupt(turn);
      await turn.completed;
      const outcome = turn.translator.outcome;
      if (outcome?.status === "failed") this.report({ type: "notice", message: `OpenCode stopped: ${outcome.error ?? "the turn failed."}`, level: "error" });
      const model = turn.translator.model;
      if (model && (model.providerID !== this.observedModel?.provider || model.modelID !== this.observedModel?.id)) {
        this.observedModel = { provider: model.providerID, id: model.modelID };
        await this.store.setObservedModel(this.threadId, this.cwd, this.observedModel);
      }
      const context = stepContext(turn.translator.lastStep, this.currentModel()?.contextWindow);
      if (context) this.context = context;
      this.usage = { ...this.usage, turns: this.usage.turns + 1 };
      await this.store.recordUsage(this.threadId, this.cwd, this.usage);
      this.settle(turn, outcome?.status === "interrupted" ? "interrupted" : outcome?.status === "failed" ? "error" : "completed", outcome?.error);
      return outcome?.texts.length ? { assistantText: outcome.texts.join("\n\n") } : {};
    } catch (error) {
      if (!turn.status) {
        const message = error instanceof Error ? error.message : String(error);
        this.report({ type: "notice", message: `OpenCode reported an error: ${message}`, level: "error" });
        for (const event of turn.translator.abandon("failed", message)) this.handleEvent(event);
        this.settle(turn, "error", message);
      }
      throw error;
    } finally {
      await this.persisting;
    }
  }

  private settle(turn: Turn, status: NonNullable<Turn["status"]>, error?: string): void {
    if (turn.status) return;
    turn.status = status;
    turn.complete();
    const index = this.turns.indexOf(turn);
    if (index >= 0) this.turns.splice(index, 1);
    this.report({ type: "usage" });
    this.report({ type: "turn-settled", status, ...(status === "error" && error ? { error } : {}) });
    this.reportQueue();
    turn.finish();
  }

  /** The workbench's level, or read-only for a thread left without a tool that writes. */
  private permissionLevel(): RuntimePermissionLevel {
    const level = this.options.permissionLevel?.() ?? "full";
    return this.tools && !openCodeToolsWrite(this.tools) ? "read-only" : level;
  }

  /** The session's rules follow the workbench's access level from the next turn on. */
  private async applyRules(live: Live): Promise<void> {
    const level = this.permissionLevel();
    if (level === this.rulesLevel || !this.sessionId) return;
    await live.server.client.updateSession(this.cwd, this.sessionId, { permission: rulesForLevel(level) });
    this.rulesLevel = level;
  }

  private ensureSession(): Promise<Live> {
    if (this.live && !this.live.server.closed) return Promise.resolve(this.live);
    this.opening ??= this.openSession().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  /** A server for the thread, its event stream, then the stored session resumed or a new one created. */
  private async openSession(): Promise<Live> {
    const level = this.permissionLevel();
    if ((level === "ask" || level === "auto") && !this.options.ask) throw new Error("OpenCode cannot ask for approvals on this host; choose read-only or full access.");
    await this.store.ensure(this.threadId, this.cwd, this.options.instance);
    let server: OpenCodeServerHandle | undefined;
    server = await this.options.connect({
      cwd: this.cwd,
      threadId: this.threadId,
      ...(this.tools ? { tools: this.tools } : {}),
      onExit: (error) => this.onExit(server, error),
    });
    let subscription: { close(): void } | undefined;
    try {
      subscription = await server.client.subscribe(this.cwd, (event) => this.onServerEvent(event), (error) => { if (error) this.onStreamEnd(server, error); });
      let session: OpenCodeSession | undefined;
      if (this.sessionId) {
        try {
          session = await server.client.getSession(this.cwd, this.sessionId);
          await server.client.updateSession(this.cwd, session.id, { permission: rulesForLevel(level) });
        } catch (error) {
          if (!missing(error)) throw error;
          this.report({ type: "notice", message: "OpenCode no longer has this conversation; a new one starts here.", level: "warning" });
        }
      }
      session ??= await server.client.createSession(this.cwd, { ...(this.title ? { title: this.title } : {}), permission: rulesForLevel(level) });
      this.rulesLevel = level;
      this.children.clear();
      if (session.id !== this.sessionId) {
        this.sessionId = session.id;
        await this.store.setSession(this.threadId, this.cwd, session.id);
      }
      this.adoptNativeTitle(session.title);
      if (session.tokens) this.usage = sessionUsage(session.tokens, session.cost, this.usage.turns);
    } catch (error) {
      subscription?.close();
      await server.close().catch(() => undefined);
      throw error;
    }
    const live: Live = { server, close: () => subscription?.close() };
    this.live = live;
    return live;
  }

  private onServerEvent(event: OpenCodeEvent): void {
    const session = sessionOf(event);
    const own = session !== undefined && session === this.sessionId;
    if ((event.type === "session.created" || event.type === "session.updated") && session && !own) {
      const parent = (event.properties.info as { parentID?: unknown } | undefined)?.parentID;
      if (typeof parent === "string" && (parent === this.sessionId || this.children.has(parent))) this.children.add(session);
      return;
    }
    const mine = own || (session !== undefined && this.children.has(session));
    if (!mine) return;
    if (event.type === "permission.asked") { void this.answerPermission(event.properties as unknown as PermissionRequest); return; }
    if (event.type === "question.asked") { void this.answerQuestion(event.properties as unknown as { id: string; questions: QuestionInfo[] }); return; }
    if (!own) return;
    if (event.type === "session.updated") {
      const info = event.properties.info as OpenCodeSession | undefined;
      this.adoptNativeTitle(info?.title);
      if (info?.tokens) {
        this.usage = sessionUsage(info.tokens, info.cost, this.usage.turns);
        this.report({ type: "usage" });
      }
      return;
    }
    const turn = this.turns[0];
    if (!turn?.posted) return;
    for (const runtimeEvent of turn.translator.push(event.type, event.properties)) this.handleEvent(runtimeEvent);
    if (turn.translator.outcome) turn.complete();
  }

  private adoptNativeTitle(value: string | undefined): void {
    const title = value && !/^New session - /u.test(value) ? derivedTitle(value) : undefined;
    if (!title || this.titleSource === "renamed" || title === this.title) return;
    this.nativeTitle = title;
    this.title = title;
    this.titleSource = "generated";
    this.persisting = this.persisting.then(async () => {
      if (this.titleSource !== "renamed" && this.title === title) await this.store.setTitle(this.threadId, this.cwd, title, "generated");
    });
    this.report({ type: "title" });
  }

  private async answerPermission(request: PermissionRequest): Promise<void> {
    const live = this.live;
    if (!live || typeof request.id !== "string") return;
    const level = this.permissionLevel();
    let reply: "once" | "always" | "reject";
    // Rules do not reach sub-agents' sessions or OpenCode's loop guard; full access answers for the user.
    if (level === "full") reply = "once";
    else if (!this.options.ask) reply = "reject";
    else {
      const dialog = permissionDialog(request);
      reply = dialog.reply(await this.options.ask(dialog.prompt).catch(() => undefined));
    }
    await live.server.client.replyPermission(this.cwd, request.id, reply).catch(() => undefined);
  }

  private async answerQuestion(request: { id: string; questions: QuestionInfo[] }): Promise<void> {
    const live = this.live;
    if (!live || typeof request.id !== "string" || !Array.isArray(request.questions)) return;
    const ask = this.options.ask;
    const dialogs = questionDialogs(request.questions);
    const replies: ExtensionUiAnswer[] = [];
    if (ask) {
      for (const prompt of dialogs.prompts) {
        const answer = await ask(prompt).catch((): ExtensionUiAnswer => ({ cancelled: true }));
        replies.push(answer);
        if ("cancelled" in answer) break;
      }
    }
    const answers = dialogs.answers(replies);
    await (answers ? live.server.client.replyQuestion(this.cwd, request.id, answers) : live.server.client.rejectQuestion(this.cwd, request.id)).catch(() => undefined);
  }

  /** The event stream ended while the server may still run: the running turn cannot be followed any more. */
  private onStreamEnd(server: OpenCodeServerHandle | undefined, error: Error): void {
    if (!server || this.live?.server !== server) return;
    this.live = undefined;
    void server.close().catch(() => undefined);
    this.failRunning(`Lost the connection to OpenCode: ${error.message}`);
  }

  private onExit(server: OpenCodeServerHandle | undefined, error: Error | undefined): void {
    if (!server || this.live?.server !== server) return;
    this.live.close();
    this.live = undefined;
    if (!error) return;
    this.report({ type: "notice", message: error.message, level: "error" });
    this.failRunning(error.message);
  }

  private failRunning(message: string): void {
    const turn = this.turns[0];
    if (!turn || turn.translator.outcome) return;
    for (const event of turn.translator.abandon("failed", message)) this.handleEvent(event);
    turn.complete();
  }

  async abort(): Promise<void> {
    const turn = this.turns[0];
    if (!turn) return;
    turn.aborted = true;
    // Before the prompt reached OpenCode there is nothing to stop; `runTurn` does it once it can.
    if (turn.posted) await this.interrupt(turn);
    await turn.done;
  }

  private async interrupt(turn: Turn): Promise<void> {
    const live = this.live;
    if (live && !live.server.closed && this.sessionId) await live.server.client.abort(this.cwd, this.sessionId).catch(() => undefined);
    const stopped = await Promise.race([turn.completed.then(() => true), wait(this.options.timeouts?.interruptMs ?? 10_000)]);
    if (stopped) return;
    // OpenCode did not confirm; the server goes with the turn.
    for (const event of turn.translator.abandon("interrupted")) this.handleEvent(event);
    turn.complete();
    if (this.live === live) this.live = undefined;
    live?.close();
    await live?.server.close().catch(() => undefined);
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
    // OpenCode's own list shows the same name; a missing server leaves it for the next start.
    if (this.live && !this.live.server.closed && this.sessionId) await this.live.server.client.updateSession(this.cwd, this.sessionId, { title: safe }).catch(() => undefined);
  }

  async waitForIdle(): Promise<void> {
    while (this.turns.length > 0) await this.turns[0]!.done;
    await this.persisting;
  }

  async dispose(): Promise<void> {
    const live = this.live;
    this.live = undefined;
    live?.close();
    if (live && !live.server.closed) await live.server.close();
    await this.persisting;
  }
}
