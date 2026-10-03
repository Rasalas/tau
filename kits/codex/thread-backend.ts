import {
  DEFAULT_THREAD_MODE as DEFAULT_MODE,
  askElicitation,
  clientMessageFingerprint,
  knownSkillNames,
  prepareSkillPrompt,
  validatePreparedPrompt,
  executionPolicyRefusal,
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
  type UiModelBilling,
  type UiSkillDraft,
  type UiThreadUsage,
  type UsageTally,
  type UsageTurn,
  appendUsageTurn,
  mergeTallies,
  unpricedUsage,
} from "tau/host-extension";
import { MISSING_THREAD, type CodexAccount, type CodexCollaborationMode, type CodexLoginRequest, type CodexLoginStart, type CodexModel, type CodexPolicy, type CodexThreadInfo, type CodexUserInput } from "./app-server.js";
import { approvalDialog, elicitationForm, elicitationResult, pageElicitation, policyForLevel, refusal } from "./approvals.js";
import { CodexTurnTranslator, codexLimitReset, contextUsage, emptyUsage, threadUsage, type CodexTokenUsage } from "./events.js";
import type { CodexRuntimeAdapter } from "./runtime-adapter.js";
import type { CodexConfiguredModel } from "./config.js";
import { usageTurnsOf, type CodexSessionStore, type CodexStoredModel } from "./session-store.js";
import { codexToolsWrite } from "./tools.js";
import { PLAN_MODE } from "./events.js";

/** What the backend needs of a live app-server; `CodexAppServer` is the real one. */
export interface CodexSessionLike {
  readonly closed: boolean;
  readonly stderr: string;
  /** Where the CLI keeps its sessions and login, from the handshake. */
  readonly codexHome?: string;
  account?(): Promise<CodexAccount | undefined>;
  /** `account/rateLimits/read`; see `limits.ts`. */
  rateLimits?(): Promise<unknown>;
  consumeResetCredit?(idempotencyKey: string): Promise<unknown>;
  loginStart?(request: CodexLoginRequest): Promise<CodexLoginStart>;
  loginCancel?(loginId: string): Promise<void>;
  logout?(): Promise<void>;
  models(): Promise<CodexModel[]>;
  setServiceTier?(threadId: string, serviceTier: string | null): Promise<void>;
  startThread(params: { cwd: string; model?: string; serviceTier?: string | null; policy: CodexPolicy }): Promise<CodexThreadInfo>;
  resumeThread(params: { threadId: string; cwd: string; model?: string; serviceTier?: string | null; policy: CodexPolicy }): Promise<CodexThreadInfo>;
  startTurn(params: { threadId: string; input: CodexUserInput[]; policy: CodexPolicy; model?: string; serviceTier?: string | null; effort?: string; mode?: CodexCollaborationMode }): Promise<string>;
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
  /** Where the thread's tool cards are kept across restarts. */
  activity?: TurnActivityStore;
  adapter: CodexRuntimeAdapter;
  store: CodexSessionStore;
  /** The instance the thread runs on; the default one when absent. */
  instance?: string;
  /** What the instance's `config.toml` sets, which a thread runs on until Codex names its model. */
  configuredModel?(): Promise<CodexConfiguredModel>;
  openSession(input: CodexSessionInput): Promise<CodexSessionLike>;
  /** Refresh external credentials between turns; false restarts and resumes the stored thread. */
  sessionCurrent?(session: CodexSessionLike): Promise<boolean>;
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
  /** What the thread's project lets its commands reach (API 1.14.0); asked before every turn. */
  executionPolicy?(): Promise<HostExecutionPolicy>;
  /** The platform the CLI runs on; this machine's by default. */
  platform?: NodeJS.Platform;
  /** A thread being created keeps only these tools, as Pi names them. */
  tools?: readonly string[];
  now?(): number;
  timeouts?: { interruptMs?: number };
  /** Prices the thread's turns the way core prices every thread (API 1.12.0). */
  priceUsage?(tallies: readonly UsageTally[]): UiThreadUsage | undefined;
  /** A turn reported the account's quota windows (`account/rateLimits/updated`). */
  onRateLimits?(snapshot: unknown): void;
  /** Direct the user to the plan controls when the Responses grant reaches its limit. */
  onUsageLimit?(): void;
}

/** A ChatGPT login is the subscription; an API key is billed per token. */
export function codexBilling(account: CodexAccount | undefined): UiModelBilling | undefined {
  if (account?.type === "chatgpt") return "subscription";
  return account?.type === "apiKey" ? "api-key" : undefined;
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;

/** Tokens between two running totals; a total that went down started over, so all of it counts. */
export function usageSince(before: UiThreadUsage | undefined, after: UiThreadUsage): Pick<UiThreadUsage, (typeof TOKEN_FIELDS)[number]> {
  const restarted = !before || TOKEN_FIELDS.some((field) => after[field] < before[field]);
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, restarted ? after[field] : after[field] - before[field]])) as Pick<UiThreadUsage, (typeof TOKEN_FIELDS)[number]>;
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
  const tiers = model.serviceTiers?.length ? model.serviceTiers : (model.additionalSpeedTiers ?? []).map((id) => ({ id, name: id === "fast" ? "Fast" : id }));
  const serviceTiers = tiers.length && !tiers.some((tier) => tier.id === "default") ? [{ id: "default", name: "Standard" }, ...tiers] : tiers;
  return {
    id: model.id,
    name: model.displayName?.trim() || model.id,
    serviceTiers,
    ...(model.defaultServiceTier ? { defaultServiceTier: model.defaultServiceTier } : {}),
    efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(model.inputModalities ? { images: model.inputModalities.includes("image") } : {}),
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

/** The capability over the kit's store; Codex's own rollout is not read back. */
function activityHistory(threadId: string, store: TurnActivityStore | undefined): Pick<ThreadBackendCapabilities, "activityHistory"> {
  return store ? { activityHistory: { load: () => store.load(threadId), save: (entry) => store.save(threadId, entry) } } : {};
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
  /** Each finished turn's tokens; the running total above is Codex's own. */
  private usageTurns: UsageTurn[] = [];
  /** The running total when the current turn started. */
  private turnBaseline?: UiThreadUsage;
  /** How the account pays, as the session's login says. */
  private billing?: UiModelBilling;
  /** The last `account/rateLimits/updated`, for when a usage limit stops a turn. */
  private rateLimits: unknown;
  private context?: UiContextUsage;
  private chosenModel?: string;
  private chosenServiceTier?: string;
  private switchingAccount = false;
  private admittingPrompts = 0;
  private strictResume = false;
  private protectContinuation = false;
  private chosenEffort?: string;
  private mode = DEFAULT_MODE;
  /** The project limits its commands' network; read before each turn. */
  private networkLimited = false;
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
      restart: { restart: async () => {
        if (this.turns.length || this.opening || this.switchingAccount || this.admittingPrompts) throw new Error("Wait for Codex to finish before restarting its session.");
        this.switchingAccount = true;
        this.strictResume = Boolean(this.codexThreadId);
        try { await this.dispose(); await this.ensureSession(); }
        finally { this.strictResume = false; this.switchingAccount = false; }
      } },
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
      ...activityHistory(threadId, options.activity),
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
      id: message.id ?? `codex-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    }));
    this.codexThreadId = record.codexThreadId;
    this.protectContinuation = Boolean(record.accountInstance);
    this.title = record.title;
    this.titleSource = record.titleSource;
    if (record.usage) this.usage = { ...record.usage };
    this.usageTurns = usageTurnsOf(record);
    this.chosenModel = record.model;
    this.chosenServiceTier = record.serviceTier;
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
      ...(this.threadUsage() ? { usage: this.threadUsage()! } : {}),
      ...(this.context ? { contextUsage: { ...this.context } } : {}),
    };
  }

  /** The finished turns and the one running, per model and billing. */
  private usageTallies(): UsageTally[] {
    const running = this.turns[0] && this.turnBaseline ? this.turnTally(this.now()) : undefined;
    return mergeTallies(running ? [...this.usageTurns, { ...running, turns: 0 }] : this.usageTurns);
  }

  private threadUsage(): UiThreadUsage | undefined {
    const tallies = this.usageTallies();
    return this.options.priceUsage ? this.options.priceUsage(tallies) : unpricedUsage(tallies);
  }

  /** The current turn's tokens so far; Codex names no price. */
  private turnTally(at: number): UsageTurn {
    const model = this.currentModelId();
    return {
      provider: MODEL_PROVIDER,
      ...(model ? { model } : {}),
      ...(this.billing ? { billing: this.billing } : {}),
      ...usageSince(this.turnBaseline, this.usage),
      costUsd: 0,
      turns: 1,
      at,
    };
  }

  async models(): Promise<UiModel[]> {
    if (this.modelList.length === 0) this.modelList = [...await this.options.models?.().catch(() => []) ?? []];
    return this.modelList.map((model) => ({ provider: MODEL_PROVIDER, id: model.id, name: model.name }));
  }

  serviceTierState() {
    const model = this.currentModel();
    return { selected: this.chosenServiceTier ?? null, defaultTier: model?.defaultServiceTier ?? null, choices: (model?.serviceTiers ?? []).map((tier) => ({ ...tier })) };
  }

  async setServiceTier(tier: string | null): Promise<void> {
    if (this.turns.length || this.opening || this.switchingAccount || this.admittingPrompts) throw new Error("Wait for Codex to finish before changing the service tier.");
    if (tier !== null && !this.currentModel()?.serviceTiers?.some((entry) => entry.id === tier)) throw new Error("This account and model do not offer that service tier.");
    this.switchingAccount = true;
    try {
      if (this.live && !this.live.closed) {
        if (!this.live.setServiceTier) throw new Error("This Codex version cannot change a thread's service tier.");
        await this.live.setServiceTier(this.codexThreadId!, tier);
      }
      await this.store.setSelection(this.threadId, this.cwd, { serviceTier: tier });
      this.chosenServiceTier = tier ?? undefined;
    } finally { this.switchingAccount = false; }
  }

  async switchAccount(account: string, change: (account: string) => void, previous: string): Promise<void> {
    if (this.turns.length || this.opening || this.switchingAccount || this.admittingPrompts) throw new Error("Wait for Codex to finish before switching accounts.");
    this.switchingAccount = true;
    this.strictResume = Boolean(this.codexThreadId);
    const oldTier = this.chosenServiceTier;
    const oldModels = this.modelList;
    try {
      await this.dispose();
      change(account);
      this.chosenServiceTier = undefined;
      await this.ensureSession();
      await this.store.setAccount(this.threadId, this.cwd, account);
      this.protectContinuation = true;
    } catch (error) {
      await this.dispose();
      change(previous);
      this.chosenServiceTier = oldTier;
      this.modelList = oldModels;
      throw error;
    } finally {
      this.strictResume = false;
      this.switchingAccount = false;
    }
  }

  private async setModel(id: string): Promise<void> {
    if (this.switchingAccount) throw new Error("Wait for the Codex account switch to finish.");
    if (this.chosenServiceTier) await this.setServiceTier(null);
    if (this.modelList.length > 0 && !this.modelList.some((model) => model.id === id)) throw new Error(`Codex offers no model "${id}" to this account.`);
    this.chosenModel = id;
    const efforts = this.currentModel()?.efforts;
    // An effort the new model does not know would be refused on the next turn.
    const resetEffort = this.chosenEffort !== undefined && efforts !== undefined && !efforts.includes(this.chosenEffort);
    if (resetEffort) this.chosenEffort = undefined;
    await this.store.setSelection(this.threadId, this.cwd, { model: id, ...(resetEffort ? { effort: null } : {}) });
  }

  private async setEffort(level: string): Promise<void> {
    if (this.switchingAccount) throw new Error("Wait for the Codex account switch to finish.");
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
    if (this.switchingAccount) throw new Error("Wait for the Codex account switch to finish.");
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Codex delivery.");
    this.admittingPrompts += 1;
    try {
      await this.readNetworkLimit();
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
    } finally { this.admittingPrompts -= 1; }
  }

  private async runTurn(turn: Turn): Promise<ThreadBackendPromptResult> {
    if (turn.status) return {};
    this.report({ type: "turn-started" });
    this.reportQueue();
    try {
      await this.readNetworkLimit();
      const live = await this.ensureSession();
      if (turn.aborted) {
        this.settle(turn, "interrupted");
        return {};
      }
      const level = this.permissionLevel();
      const mode = this.collaborationMode();
      this.turnBaseline = { ...this.usage };
      const id = await live.startTurn({
        threadId: this.codexThreadId!,
        input: turn.input,
        policy: this.policy(level),
        ...(this.chosenModel ? { model: this.chosenModel } : {}),
        ...(this.chosenServiceTier ? { serviceTier: this.chosenServiceTier } : {}),
        ...(this.chosenEffort ? { effort: this.chosenEffort } : {}),
        ...(mode ? { mode } : {}),
      });
      turn.codexTurnId ??= id;
      if (turn.aborted) await this.interrupt(turn);
      await turn.completed;
      const outcome = turn.translator.outcome;
      if (outcome?.status === "failed") this.report({ type: "notice", message: `Codex stopped: ${outcome.error ?? "the turn failed."}`, level: "error" });
      this.usage = { ...this.usage, turns: this.usage.turns + 1 };
      const finished = this.turnTally(this.now());
      this.turnBaseline = undefined;
      this.usageTurns = appendUsageTurn(this.usageTurns, finished);
      await this.store.recordUsage(this.threadId, this.cwd, this.usage, finished);
      if (outcome?.usageLimit) this.options.onUsageLimit?.();
      const limit = outcome?.usageLimit ? codexLimitReset(this.rateLimits, this.now()) : undefined;
      this.settle(turn, outcome?.status === "interrupted" ? "interrupted" : outcome?.status === "failed" ? "error" : "completed", outcome?.error,
        outcome?.usageLimit ? { ...(limit ? { resetsAt: limit } : {}) } : undefined);
      return outcome?.texts.length ? { assistantText: outcome.texts.join("\n\n") } : {};
    } catch (error) {
      if (this.turnBaseline) {
        // A failed turn still used what it used.
        const partial = this.turnTally(this.now());
        this.turnBaseline = undefined;
        if (partial.totalTokens > 0) {
          this.usageTurns = appendUsageTurn(this.usageTurns, partial);
          await this.store.recordUsage(this.threadId, this.cwd, this.usage, partial).catch(() => undefined);
        }
      }
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

  /**
   * Reads the project's limit. Codex's sandbox has no host list, so a limited
   * project runs without network; on Windows it has no sandbox that holds, so
   * the prompt is refused.
   */
  private async readNetworkLimit(): Promise<void> {
    const policy = await this.options.executionPolicy?.();
    this.networkLimited = policy?.network === "loopback";
    if (this.networkLimited && (this.options.platform ?? process.platform) === "win32") throw new Error(executionPolicyRefusal(policy, "Codex on Windows"));
  }

  private policy(level: RuntimePermissionLevel) {
    return policyForLevel(level, { network: this.networkLimited ? "none" : "any" });
  }

  /** The workbench's level, or read-only for a thread left without a tool that writes. */
  private permissionLevel(): RuntimePermissionLevel {
    const level = this.options.permissionLevel?.() ?? "full";
    return this.tools && !codexToolsWrite(this.tools) ? "read-only" : level;
  }

  /** The live app-server, spawned on demand; the stored thread is resumed, a gone one started afresh. */
  private async ensureSession(): Promise<CodexSessionLike> {
    const previous = this.live;
    if (previous && !previous.closed) {
      const current = !this.options.sessionCurrent || await this.options.sessionCurrent(previous);
      if (current && this.live === previous && !previous.closed) return previous;
      if (this.live === previous) this.live = undefined;
      await previous.close();
    }
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
      const policy = this.policy(level);
      const model = this.chosenModel;
      let info: CodexThreadInfo;
      if (this.codexThreadId) {
        try {
          info = await session.resumeThread({ threadId: this.codexThreadId, cwd: this.cwd, policy, ...(model ? { model } : {}), ...(this.strictResume ? { serviceTier: null } : this.chosenServiceTier ? { serviceTier: this.chosenServiceTier } : {}) });
        } catch (error) {
          if (this.strictResume || this.protectContinuation) throw error;
          if (!MISSING_THREAD.test(error instanceof Error ? error.message : String(error))) throw error;
          this.report({ type: "notice", message: "Codex no longer has this conversation; a new one starts here.", level: "warning" });
          info = await session.startThread({ cwd: this.cwd, policy, ...(model ? { model } : {}), ...(this.strictResume ? { serviceTier: null } : this.chosenServiceTier ? { serviceTier: this.chosenServiceTier } : {}) });
        }
      } else {
        info = await session.startThread({ cwd: this.cwd, policy, ...(model ? { model } : {}), ...(this.strictResume ? { serviceTier: null } : this.chosenServiceTier ? { serviceTier: this.chosenServiceTier } : {}) });
      }
      if (this.strictResume && info.thread.id !== this.codexThreadId) throw new Error("The new account did not resume the same Codex session.");
      if (info.thread.id !== this.codexThreadId) {
        this.codexThreadId = info.thread.id;
        await this.store.setCodexThread(this.threadId, this.cwd, info.thread.id);
      }
      if (info.reasoningEffort) this.observedEffort = info.reasoningEffort;
      if (info.model && info.model !== this.observedModel) {
        this.observedModel = info.model;
        await this.store.setObservedModel(this.threadId, this.cwd, info.model);
      }
      this.billing = codexBilling(await session.account?.().catch(() => undefined)) ?? this.billing;
      const models = (await session.models().catch((error) => { if (this.strictResume) throw error; return []; })).map(storedModel);
      if (models.length > 0 || this.strictResume) {
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
      this.options.onRateLimits?.(params.rateLimits);
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
    const form = method === "mcpServer/elicitation/request" ? elicitationForm(params) : undefined;
    if (form && form.fields.length > 0) {
      if (!this.options.ask) return elicitationResult({ action: "decline" });
      return elicitationResult(await askElicitation({ ...form, ask: this.options.ask, decorate: pageElicitation(form.source) }));
    }
    const turn = this.turns[0];
    const dialog = approvalDialog(method, params, (itemId) => turn?.translator.changes.get(itemId) ?? []);
    if (!dialog) {
      const answer = refusal(method);
      if (answer !== undefined) return answer;
      throw new Error(`Tau does not answer Codex's ${method}.`);
    }
    // A limited project's network is not opened one command at a time.
    if (this.networkLimited && params.networkApprovalContext) return dialog.resultFor([]);
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
