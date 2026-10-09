import { ClaudeNativeAgents } from "./native-agents.js";
import { stat } from "node:fs/promises";
import type { ModelInfo, PermissionMode, PermissionResult, PermissionUpdate, UserDialogRequest, UserDialogResult } from "@anthropic-ai/claude-agent-sdk";
import {
  executionPolicyRefusal,
  clientMessageFingerprint,
  knownSkillNames,
  prepareSkillPrompt,
  validatePreparedPrompt,
  type BackendPrompt,
  type CompletionRequest,
  type ExtensionUiAnswer,
  type HostExecutionPolicy,
  type HostMcpConnection,
  type PreparedPrompt,
  type RuntimePermissionLevel,
  type ThreadBackendCapabilities,
  type ThreadBackendPromptInput,
  type ThreadBackendPromptResult,
  type ThreadBackendState,
  type ThreadCatalogView,
  type ThreadGoalCapability,
  type ThreadRuntimeBackend,
  type ThreadRuntimeEvent,
  type ThreadTitleSource,
  type UiComposerCommand,
  type UiContextUsage,
  type UiMessage,
  type UiModel,
  type UiPromptAttachment,
  type UiModelBilling,
  type UiSkillDraft,
  type UiThreadGoal,
  type UiThreadUsage,
  type UsageTally,
  type UsageTurn,
  appendUsageTurn,
  mergeTallies,
  unpricedUsage,
} from "tau/host-extension";
import {
  askUserQuestionAnswer,
  askUserQuestionPrompts,
  permissionPrompt,
  permissionResultFor,
  PLAN_CAPTURED,
  PLAN_DECLINED,
  planPrompt,
  proposedPlanText,
  resumeDialogPrompt,
  resumeDialogResult,
} from "./approvals.js";
import { EFFORT_LEVELS, apiKeyBilling, probeBilling, uiModel, versionedModelName, type EffortLevel } from "./probe.js";
import { assertClaudePermissionPolicySupported, runtimePermissionPolicy, type ClaudeCodeAgentRuntimeAdapter, type ClaudeNetworkLimit, type ClaudeTurnHooks } from "./runtime-adapter.js";
import { addUsage, SdkTurnTranslator } from "./sdk-events.js";
import type { ClaudeSdkSession, SendPriority, UserContent } from "./sdk-session.js";
import { ClaudeRuntimeSessionStore, usageTurnsOf, type ClaudeStoredGoal } from "./session-store.js";

function derivedClaudeTitle(text: string): string | undefined {
  // This function normally receives the backend's visible projection. Keep a
  // defensive, line-aware guard for old/raw records without classifying an
  // ordinary user sentence such as `location=...` as runtime syntax.
  const visible = /<skill\b/iu.test(text) ? "Skill invocation" : text;
  const firstLine = visible.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  if (!firstLine || /^(?:<skill\b|\s{0,3}<skill\b)/iu.test(firstLine)) return undefined;
  const title = firstLine.replace(/(?:\*\*|__|~~|`)+/gu, "").replace(/[.!?:;]+$/u, "").trim();
  return title ? title.slice(0, 80) : undefined;
}

/** Images go before the text: the CLI reads a slash command only from a trailing text block. */
export function promptContent(text: string, attachments: readonly UiPromptAttachment[] | undefined): UserContent {
  const images = (attachments ?? []).flatMap((attachment) => attachment.kind === "image" ? [attachment] : []);
  if (!images.length) return text;
  return [
    ...images.map((attachment) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: attachment.mimeType as "image/png", data: attachment.data },
    })),
    { type: "text" as const, text },
  ];
}

const MISSING_SESSION = /(?:session|conversation)[^\n]*(?:not found|does not exist|unknown|missing|invalid)|(?:no|cannot|could not)\s+(?:find\s+)?(?:the\s+)?(?:session|conversation)/iu;
/** The thinking picker's first entry: the CLI's own effort. */
const DEFAULT_EFFORT = "default";
const PLAN_MODE = "plan";
const DEFAULT_MODE = "default";

function effortLevel(value: string | undefined): EffortLevel | undefined {
  return (EFFORT_LEVELS as readonly string[]).includes(value ?? "") ? value as EffortLevel : undefined;
}
const INTERRUPT_GRACE_MS = 3_000;
/** The CLI keeps a conversation in Anthropic's one-hour prompt cache. */
const PROMPT_CACHE_TTL_MS = 60 * 60_000;
const COMPACT_COMMAND = "/compact";
const GOAL_CLEAR_COMMAND = "/goal clear";
const STDERR_TAIL_BYTES = 8 * 1024;

export interface ClaudeThreadBackendOptions {
  adapter: ClaudeCodeAgentRuntimeAdapter;
  store: ClaudeRuntimeSessionStore;
  /** The instance the thread runs on; the default one when absent. */
  instance?: string;
  commands?: readonly UiComposerCommand[] | (() => readonly UiComposerCommand[] | Promise<readonly UiComposerCommand[]>);
  /** Whole messages, for a host that offers no event route. */
  onMessage?(message: UiMessage): void;
  /** The host's event route; with it the thread streams. */
  onEvent?(event: ThreadRuntimeEvent): void;
  /** The workbench's dialog surface; with it Claude's questions reach the user and the `ask` level works. */
  ask?(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
  projectName: string;
  branch?: string;
  permissionLevel?: () => RuntimePermissionLevel;
  /** What the thread's project lets its commands reach (API 1.14.0); asked before every prompt. */
  executionPolicy?(): Promise<HostExecutionPolicy>;
  /** The platform the CLI runs on; this machine's by default. */
  platform?: NodeJS.Platform;
  /** Tau's tools for this thread over MCP, asked each time a session starts; `tools` narrows them. */
  mcpServer?(tools?: readonly string[]): Promise<HostMcpConnection | undefined>;
  /** A thread being created keeps only these tools, as Pi names them. */
  tools?: readonly string[];
  now?(): number;
  /** How long an interrupt may take before the session is closed instead. */
  interruptGraceMs?: number;
  /** Prices the thread's turns the way core prices every thread (API 1.12.0). */
  priceUsage?(tallies: readonly UsageTally[]): UiThreadUsage | undefined;
  /** How the instance's login pays, as its last probe found; the live session's own word wins. */
  billing?(): UiModelBilling | undefined;
  /** A turn carried the plan's windows (`rate_limit_event`). */
  onRateLimits?(infos: ReadonlyArray<Record<string, unknown>>): void;
  /** The user told the CLI's resume question never to ask again. */
  onResumeQuestionOff?(): void;
}

interface LiveSession {
  session: ClaudeSdkSession;
  mode: PermissionMode;
  /** The network limit the session was started with; `""` for none. */
  network: string;
  /** The session resumed an earlier one rather than creating it. */
  resumed: boolean;
  /** The first result of this session flips the store to "started". */
  confirmed: boolean;
  stderr: string;
}

interface Turn {
  translator: SdkTurnTranslator;
  text: string;
  /** A `/compact` or `/goal clear` Tau sent; the composer's queue never lists it. */
  compaction?: boolean;
  /** A turn the CLI began on its own, e.g. when a background agent finished; no send waits on it. */
  unprompted?: boolean;
  /** Set once its result arrived and the turn was settled. */
  status?: "completed" | "interrupted" | "error";
}

/**
 * Claude's complete thread owner. It never constructs an AgentSession or
 * consults Pi's SessionManager, model catalog, context window, or extensions.
 * One SDK session lives as long as the thread is live (ADR 0004); a turn is a
 * user message and the result that consumed it. A steer joins the running
 * turn; a follow-up waits behind it.
 */
export class ClaudeThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind: string;
  readonly runtimeAdapter: ClaudeCodeAgentRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities;
  private record?: Awaited<ReturnType<ClaudeRuntimeSessionStore["get"]>>;
  private messages: UiMessage[] = [];
  private live?: LiveSession;
  /** The running turn first, then the ones queued behind it. */
  private readonly turns: Turn[] = [];
  private steering: string[] = [];
  private title?: string;
  private titleSource?: ThreadTitleSource;
  private usage: UiThreadUsage = SdkTurnTranslator.emptyUsage();
  /** Each finished turn's tokens per model; `usage` is their running total. */
  private usageTurns: UsageTurn[] = [];
  /** Turns settled but not written yet; `persistUsage` writes them with the total. */
  private unsavedTurns: UsageTurn[] = [];
  /** The live session's login, once it answered. */
  private billing?: UiModelBilling;
  private contextUsage?: UiContextUsage;
  /** The model the session reports running. */
  private model?: string;
  /** What the user chose for this thread; the CLI's defaults otherwise. */
  private chosenModel?: string;
  private chosenEffort?: EffortLevel;
  private mode = DEFAULT_MODE;
  private observedEffort?: string;
  private modelInfos?: ModelInfo[];
  /** The only tools this thread keeps, from its record. */
  private tools?: string[];
  private readonly now: () => number;

  constructor(
    readonly threadId: string,
    readonly cwd: string,
    options: ClaudeThreadBackendOptions,
  ) {
    this.runtimeAdapter = options.adapter;
    this.kind = options.adapter.id;
    this.store = options.store;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.capabilities = {
      titles: { title: () => this.runtimeAdapter.nativeTitle?.(this.cwd, this.providerSessionId) ?? Promise.resolve(undefined) },
      ...(this.runtimeAdapter.complete ? { completions: {
        complete: (_provider: string, modelId: string, request: CompletionRequest) => this.runtimeAdapter.complete!(this.cwd, modelId, request),
        models: () => this.models(),
        modelApi: () => "anthropic-messages",
      } } : {}),
      catalogWrite: {
        setModel: (_provider, id) => this.setModel(id),
        setThinkingLevel: (level) => this.setEffort(level),
      },
      // Tau's plan is Claude's plan permission mode, whatever the access level.
      mode: {
        modes: () => [PLAN_MODE],
        current: () => this.mode,
        set: (mode) => this.setMode(mode),
      },
      // The SDK resumes the stored session itself, so a continuation is an
      // ordinary turn; there is no message kind the transcript hides.
      resume: {
        hiddenPrompt: false,
        notice: async (text) => { this.note(text); },
      },
      compaction: { compact: () => this.compact() },
      goals: this.goalCapability,
      restart: { restart: async () => {
        if (this.restarting || this.admittingPrompts || this.turns.length || this.backgroundTasks.size) throw new Error("Wait for Claude's running work and background tasks before restarting its session.");
        this.restarting = true;
        try { await this.dispose(); await this.skills(); }
        finally { this.restarting = false; }
      } },
    };
  }

  /** Claude's `/goal`, as its `active_goal` frames last said. */
  private goal?: ClaudeStoredGoal;
  /** Tau sent `/goal clear`: the goal's end is the user's, not a verdict. */
  private clearingGoal = false;
  /** The goal's record and the transcript's notices, written in order; `dispose` waits for them. */
  private writes: Promise<void> = Promise.resolve();
  private readonly goalCapability: ThreadGoalCapability = {
    current: () => this.uiGoal(),
    // The CLI's own command, sent as the prompt the transcript shows.
    set: async (objective) => { this.clearingGoal = false; return { prompt: `/goal ${objective}` }; },
    pause: async () => { throw new Error("Claude Code cannot pause a goal: stop the turn, or end the goal."); },
    resume: async () => {
      if (!this.goal || this.goal.status === "active") return undefined;
      this.clearingGoal = false;
      return { prompt: `/goal ${this.goal.condition}` };
    },
    clear: () => this.clearGoal(),
    dismiss: async () => { this.setGoal(undefined); },
  };
  private restarting = false;
  private admittingPrompts = 0;
  private commandList: UiComposerCommand[] = [];
  private readonly backgroundTasks = new Set<string>();
  private backgroundTaskLevels = false;
  private readonly store: ClaudeRuntimeSessionStore;
  private readonly options: ClaudeThreadBackendOptions;

  /** @deprecated Use threadId. */
  get sessionId(): string { return this.threadId; }
  get providerSessionId(): string {
    return this.record?.claudeSessionId ?? this.threadId;
  }

  async start(mode: "create" | "resume"): Promise<void> {
    if (mode === "create") {
      this.record = await this.store.ensure(this.threadId, this.cwd, this.options.instance);
      if (this.options.tools) {
        await this.store.setTools(this.threadId, this.cwd, this.options.tools);
        this.record = await this.store.get(this.threadId) ?? this.record;
      }
    } else {
      this.record = await this.store.get(this.threadId) ?? await this.store.ensure(this.threadId, this.cwd, this.options.instance);
      if (this.record.cwd !== this.cwd) throw new Error("Claude session belongs to another workspace.");
    }
    this.restoreRecord(this.record);
    await this.skills();
  }

  private restoreRecord(record: NonNullable<ClaudeThreadRuntimeBackend["record"]>): void {
    this.messages = record.messages.map((message, index) => ({
      id: `claude-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
      ...(message.skill ? { skill: { ...message.skill } } : {}),
      ...(message.compaction ? { compaction: { ...message.compaction } } : {}),
    }));
    this.title = record.title;
    this.titleSource = record.titleSource;
    if (record.usage) this.usage = { ...record.usage };
    this.usageTurns = usageTurnsOf(record);
    this.chosenModel = record.model;
    this.chosenEffort = effortLevel(record.effort);
    this.mode = record.mode ?? DEFAULT_MODE;
    this.model = this.chosenModel ?? record.observedModel;
    this.tools = record.tools;
    this.contextUsage = record.contextUsage ? { ...record.contextUsage } : undefined;
    // A restart leaves an active goal unknown: Claude's session may still hold it.
    this.goal = record.goal?.status === "active"
      ? { ...record.goal, status: "unconfirmed", reason: "Tau restarted while this goal ran. Claude Code may still hold it; End goal sends /goal clear.", updatedAt: this.now() }
      : record.goal;
    if (this.goal) this.report({ type: "goal" });
  }

  async transcript(): Promise<UiMessage[]> { return this.messages.map((message) => ({ ...message, ...(message.skill ? { skill: { ...message.skill } } : {}) })); }
  async skills(): Promise<UiComposerCommand[]> {
    const commands = this.options.commands;
    if (!commands) return [];
    const value = typeof commands === "function" ? await commands() : commands;
    this.commandList = value.map((command) => ({ ...command }));
    return this.commandList;
  }
  composerCommands(): UiComposerCommand[] {
    return this.commandList.map((command) => ({ ...command }));
  }

  state(): ThreadBackendState {
    const running = this.turns[0];
    return {
      streaming: running !== undefined,
      idle: running === undefined && !this.nativeAgents.tracker.busy,
      hasMessages: this.messages.length > 0,
      ...(this.title ? { title: this.title } : {}),
      ...(this.titleSource ? { titleSource: this.titleSource } : {}),
      activeTools: [...(running?.translator.running.values() ?? [])].map((tool) => tool.name),
      supportsImageInput: true,
      extensionCount: 0,
    };
  }

  catalogView(): ThreadCatalogView {
    const current = this.model;
    // The CLI's "default" row resolves to a real model; a thread that runs that model is named after the model, not the row.
    const info = current
      ? this.modelInfos?.find((candidate) => candidate.value === current)
        ?? this.modelInfos?.find((candidate) => candidate.value !== "default" && candidate.resolvedModel === current)
        ?? this.modelInfos?.find((candidate) => candidate.resolvedModel === current)
      : undefined;
    const model: UiModel | undefined = this.model ? { provider: "anthropic", id: info?.value ?? this.model, name: info ? versionedModelName(info) : this.model } : undefined;
    const levels = info?.supportedEffortLevels ?? EFFORT_LEVELS;
    return {
      ...(model ? { model } : {}),
      // "default" is the CLI's own effort; the observed one is shown while it applies.
      thinkingLevel: this.chosenEffort ?? (this.observedEffort ? `${DEFAULT_EFFORT} (${this.observedEffort})` : DEFAULT_EFFORT),
      thinkingLevels: [this.chosenEffort ? DEFAULT_EFFORT : (this.observedEffort ? `${DEFAULT_EFFORT} (${this.observedEffort})` : DEFAULT_EFFORT), ...levels],
      allTools: [],
      ...(this.threadUsage() ? { usage: this.threadUsage()! } : {}),
      ...(this.contextUsage ? { contextUsage: { ...this.contextUsage } } : {}),
    };
  }

  private threadUsage(): UiThreadUsage | undefined {
    const tallies = mergeTallies(this.usageTurns);
    return this.options.priceUsage ? this.options.priceUsage(tallies) : unpricedUsage(tallies);
  }

  /** The plan's models: from the live session when there is one, from a shared probe otherwise. */
  async models(): Promise<UiModel[]> {
    if (!this.modelInfos) {
      const live = this.live && !this.live.session.closed ? this.live.session : undefined;
      this.modelInfos = live ? await live.supportedModels() : (await this.runtimeAdapter.probe()).modelInfos;
    }
    return this.modelInfos.map(uiModel);
  }

  private async setModel(id: string): Promise<void> {
    if (this.restarting) throw new Error("The Claude session is restarting.");
    this.chosenModel = id;
    this.model = id;
    await this.store.setSelection(this.threadId, this.cwd, { model: id });
    const live = this.live && !this.live.session.closed ? this.live.session : undefined;
    if (live) await live.setModel(id);
  }

  private async setEffort(level: string): Promise<void> {
    if (this.restarting) throw new Error("The Claude session is restarting.");
    const effort = effortLevel(level);
    if (!effort && !level.startsWith(DEFAULT_EFFORT)) throw new Error(`Claude Code knows no effort "${level}".`);
    this.chosenEffort = effort;
    await this.store.setSelection(this.threadId, this.cwd, { effort });
    const live = this.live && !this.live.session.closed ? this.live.session : undefined;
    if (live) await live.setEffort(effort ?? null);
  }

  private async setMode(mode: string): Promise<void> {
    if (this.restarting) throw new Error("The Claude session is restarting.");
    if (mode !== PLAN_MODE && mode !== DEFAULT_MODE) throw new Error(`Claude Code offers no "${mode}" mode.`);
    this.mode = mode;
    await this.store.setSelection(this.threadId, this.cwd, { mode: mode === DEFAULT_MODE ? undefined : mode });
  }

  async preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
    assertClaudePermissionPolicySupported(runtimePermissionPolicy(this.options.permissionLevel?.() ?? "full"), { canAsk: this.options.ask !== undefined });
    const commands = await this.skills();
    const effectiveCommands = commands;
    const prepared = prepareSkillPrompt(text, this.runtimeAdapter, effectiveCommands, skill);
    const result: PreparedPrompt = {
      tauThreadId: this.threadId,
      providerSessionId: this.providerSessionId,
      sessionId: this.threadId,
      backendKind: this.kind,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, [...knownSkillNames(effectiveCommands)]),
    };
    validatePreparedPrompt(text, result, {
      backendKind: this.kind,
      threadId: this.threadId,
      providerSessionId: this.providerSessionId,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      commands: effectiveCommands,
    });
    return result;
  }

  async prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult> {
    if (this.restarting) throw new Error("The Claude session is restarting. Wait before sending another message.");
    this.admittingPrompts += 1;
    try {
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Claude delivery.");
    const folder = await stat(this.cwd).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw new Error(`This thread's working folder is missing: ${this.cwd}. Restore the folder before retrying, or start a new thread in an existing project.`, { cause: error });
      }
      throw error;
    });
    if (!folder.isDirectory()) throw new Error(`This thread's working folder is not a directory: ${this.cwd}. Restore the folder before retrying, or start a new thread in an existing project.`);
    const permissionLevel = this.options.permissionLevel?.() ?? "full";
    const mode = this.mode === PLAN_MODE ? "plan" : runtimePermissionPolicy(permissionLevel).permissionMode;
    assertClaudePermissionPolicySupported({ permissionMode: mode }, { canAsk: this.options.ask !== undefined });
    const network = await this.networkLimit();
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    this.assertPreparedPrompt(input.text, prepared, await this.skills());
    const clientMessageId = input.identity?.clientMessageId;
    if (clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
      if (existing) {
        const sameSkill = JSON.stringify(existing.skill ?? null) === JSON.stringify(prepared.skill ?? null);
        if (existing.text === prepared.visibleText && sameSkill) return {};
        throw new Error(`Claude transcript already contains a conflicting message id '${clientMessageId}'.`);
      }
    }
    // Persist the visible message as soon as the runtime accepts it; the
    // transport separately records the attempt before creating a child.
    const user: UiMessage = {
      id: `claude-user-${clientMessageId ?? this.now()}`,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(input.identity?.clientTurnId ? { clientTurnId: input.identity.clientTurnId } : {}),
      role: "user",
      text: prepared.visibleText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      ...(input.attachments?.some((attachment) => attachment.kind === "image")
        ? { images: input.attachments.flatMap((attachment) => attachment.kind === "image" ? [{ mimeType: attachment.mimeType, data: attachment.data }] : []) }
        : {}),
      timestamp: this.now(),
    };
    this.messages.push(user);
    await this.persist([user]);
    // No title is stored here: the thread index names an unnamed thread after
    // its first message, and a stored name would stop the title generator.
    const content = promptContent(prepared.runtimeText, input.attachments);
    if (input.delivery === "steer" && this.turns.length > 0) {
      // A steer joins the running turn and returns once it is on its way; the
      // turn's own result clears it from the queue the composer shows.
      const live = await this.ensureSession(permissionLevel, mode, false, network);
      this.deliverMessage(user);
      input.onAdmitted?.(true);
      this.steering.push(prepared.visibleText);
      this.reportQueue();
      // "next" folds it into the running turn after the current tool call; "now" would interrupt that call.
      void live.session.send(content, "next").catch(() => undefined).finally(() => {
        this.steering = this.steering.filter((text) => text !== prepared.visibleText);
        this.reportQueue();
      });
      return {};
    }
    let echoed = false;
    for (let attempt = 0; ; attempt += 1) {
      const live = await this.ensureSession(permissionLevel, mode, attempt > 0, network);
      const running = this.turns.length > 0;
      const turn: Turn = { translator: new SdkTurnTranslator(this.now), text: prepared.visibleText };
      this.turns.push(turn);
      if (!running) this.beginTurn(turn);
      else this.reportQueue();
      if (!echoed) {
        echoed = true;
        this.deliverMessage(user);
        input.onAdmitted?.(true);
      }
      const priority: SendPriority = running || input.queued ? "later" : "next";
      try {
        await live.session.send(content, priority);
      } catch (error) {
        // The session ended: onExit already settled every turn it held.
        if (error instanceof Error && error.name === "AbortError") return {};
        throw error;
      }
      const outcome = turn.translator.outcome;
      if (attempt === 0 && outcome?.error && MISSING_SESSION.test(outcome.error) && live.resumed && !this.record?.createFallbackUsed) {
        // The id Claude was asked to resume is gone: one fresh start under the same id.
        await this.store.markAttemptOutcome(this.threadId, this.cwd, "missing");
        await this.store.markCreateFallbackUsed(this.threadId, this.cwd);
        this.record = await this.store.get(this.threadId);
        await live.session.close();
        continue;
      }
      await this.persistUsage();
      if (outcome?.interrupted) return {};
      if (!live.confirmed && !outcome?.error) {
        live.confirmed = true;
        await this.store.markStarted(this.threadId, this.cwd);
        await this.store.markAttemptOutcome(this.threadId, this.cwd, "started");
        this.record = await this.store.get(this.threadId);
      }
      if (outcome?.error) {
        await this.store.markAttemptOutcome(this.threadId, this.cwd, "failed");
        throw new Error(`Claude Code reported an error: ${outcome.error}${live.stderr.trim() ? `\n${live.stderr.trim()}` : ""}`);
      }
      return { assistantText: outcome?.texts.join("\n\n") ?? "" };
    }
    } finally { this.admittingPrompts -= 1; }
  }

  /**
   * The project's network limit, for the session's sandbox. The SDK's sandbox
   * does not hold on Windows here, so a limited prompt is refused there.
   */
  private async networkLimit(): Promise<ClaudeNetworkLimit | undefined> {
    const policy = await this.options.executionPolicy?.();
    if (policy?.network !== "loopback") return undefined;
    if ((this.options.platform ?? process.platform) === "win32") throw new Error(executionPolicyRefusal(policy, "The Agent SDK runtime on Windows"));
    return { allowHosts: policy.allowHosts };
  }

  /** The thread's live session, opened on the first turn and after a close; `create` forces a fresh session under the stored id. */
  private async ensureSession(permissionLevel: RuntimePermissionLevel, mode: PermissionMode, create: boolean, network?: ClaudeNetworkLimit): Promise<LiveSession> {
    const limit = network ? JSON.stringify(network.allowHosts) : "";
    // The sandbox is fixed when the CLI starts: a changed limit resumes the session in a new one, between turns.
    if (this.live && !this.live.session.closed && this.live.network !== limit && this.turns.length === 0) {
      await this.live.session.close();
      this.live = undefined;
    }
    if (this.live && !this.live.session.closed) {
      if (this.live.mode !== mode) {
        await this.live.session.setPermissionMode(mode);
        this.live.mode = mode;
      }
      return this.live;
    }
    const record = await this.store.ensure(this.threadId, this.cwd);
    // `attempted` is persisted before spawning. On the next request a
    // previously attempted-but-unconfirmed id is resumed first; only a
    // clear "missing session" response permits one create fallback.
    const resumed = !create && (record.started || record.attempted);
    await this.store.markAttempted(this.threadId, this.cwd);
    this.record = await this.store.get(this.threadId);
    // Without the endpoint the thread still runs, only without Tau's tools.
    const mcpServer = await this.options.mcpServer?.(this.tools).catch(() => undefined);
    const live: LiveSession = { session: undefined as unknown as ClaudeSdkSession, mode, network: limit, resumed, confirmed: false, stderr: "" };
    this.backgroundTasks.clear();
    this.backgroundTaskLevels = false;
    live.session = this.runtimeAdapter.openSession({
      cwd: this.cwd,
      claudeSessionId: record.claudeSessionId,
      started: resumed,
      permissionLevel,
      ...(this.chosenModel ? { model: this.chosenModel } : {}),
      ...(this.chosenEffort ? { effort: this.chosenEffort } : {}),
      ...(this.turnHooks() ? { hooks: this.turnHooks() } : {}),
      ...(mcpServer ? { mcpServer } : {}),
      ...(this.tools ? { tools: this.tools } : {}),
      ...(network ? { network } : {}),
      onMessage: (frame, unclaimed) => this.onFrame(frame, unclaimed),
      onExit: (error) => this.onExit(live, error),
      onStderr: (chunk) => { live.stderr = `${live.stderr}${chunk}`.slice(-STDERR_TAIL_BYTES); },
    });
    this.live = live;
    void live.session.accountInfo?.().then((account) => { this.billing = probeBilling(account) ?? this.billing; }, () => undefined);
    return live;
  }

  private readonly nativeAgents = new ClaudeNativeAgents();

  private onFrame(frame: Parameters<SdkTurnTranslator["push"]>[0], unclaimed = false): void {
    // Not in the SDK's message union, but the query stream passes it on (sdk.d.ts `SDKActiveGoalMessage`).
    if ((frame as { type: string }).type === "active_goal") {
      this.onActiveGoal((frame as unknown as { value: { condition: string; iterations: number; last_reason?: string } | null }).value);
      return;
    }
    if (frame.type === "system") {
      if (frame.subtype === "background_tasks_changed") {
        this.backgroundTaskLevels = true;
        this.backgroundTasks.clear();
        for (const task of frame.tasks) this.backgroundTasks.add(task.task_id);
      } else if (!this.backgroundTaskLevels && frame.subtype === "task_started" && frame.is_backgrounded !== false) this.backgroundTasks.add(frame.task_id);
      else if (!this.backgroundTaskLevels && frame.subtype === "task_notification") this.backgroundTasks.delete(frame.task_id);
    }
    for (const event of this.nativeAgents.push(frame)) this.handleEvent(event);
    if ("parent_tool_use_id" in frame && frame.parent_tool_use_id) return;
    if ((frame.type === "assistant" || frame.type === "user") && Array.isArray(frame.message.content)) {
      frame = { ...frame, message: { ...frame.message, content: frame.message.content.filter((block) => {
        if (block.type === "tool_use") return block.name !== "Agent" && block.name !== "Task";
        if (block.type === "tool_result") return !this.nativeAgents.owns(block.tool_use_id);
        return true;
      }) } } as typeof frame;
    }
    // A result no send waits on ends only a turn the CLI began itself.
    if (frame.type === "result" && unclaimed && !this.turns[0]?.unprompted) return;
    // A prompt the CLI folded into its own turn: that turn ends with it.
    if (frame.type === "result" && !unclaimed && this.turns[0]?.unprompted && this.turns.length > 1) this.settleTurn(this.turns.shift()!, "completed");
    if (!this.turns[0] && (frame.type === "assistant" || frame.type === "stream_event")) {
      // The CLI answers a finished background task with a turn of its own.
      const turn: Turn = { translator: new SdkTurnTranslator(this.now), text: "", unprompted: true };
      this.turns.push(turn);
      this.beginTurn(turn);
    }
    const turn = this.turns[0];
    if (!turn) {
      // Before any turn: remember what the session says about itself.
      if (frame.type === "system") {
        const probe = new SdkTurnTranslator(this.now);
        probe.push(frame);
        this.noteFacts(probe.facts);
      }
      return;
    }
    const events = turn.translator.push(frame);
    for (const event of events) this.handleEvent(event);
    if (frame.type !== "result" || !turn.translator.outcome) return;
    // Bookkeeping right here, before the CLI's next frame: the queued turn
    // behind this one starts the moment this result is in.
    this.turns.shift();
    const outcome = turn.translator.outcome;
    this.settleTurn(turn, outcome.interrupted ? "interrupted" : outcome.error ? "error" : "completed");
    if (turn.unprompted) void this.persistUsage().catch(() => undefined);
    const next = this.turns[0];
    if (next) this.beginTurn(next);
    else this.reportQueue();
  }

  private beginTurn(_turn: Turn): void {
    this.report({ type: "turn-started" });
    this.reportQueue();
  }

  private settleTurn(turn: Turn, status: NonNullable<Turn["status"]>): void {
    if (turn.status) return;
    turn.status = status;
    const outcome = turn.translator.outcome;
    this.noteFacts(turn.translator.facts);
    if (turn.translator.facts.rateLimits?.length) this.options.onRateLimits?.(turn.translator.facts.rateLimits);
    if (outcome) {
      this.usage = addUsage(this.usage, outcome.usage);
      const billing = this.billing ?? this.options.billing?.() ?? apiKeyBilling(turn.translator.facts.apiKeySource);
      const at = this.now();
      for (const tally of outcome.tallies) {
        const dated: UsageTurn = { ...tally, ...(billing ? { billing } : {}), at };
        this.usageTurns = appendUsageTurn(this.usageTurns, dated);
        this.unsavedTurns.push(dated);
      }
      if (outcome.contextUsage || outcome.compacted) this.noteContext(outcome.contextUsage, at);
      this.report({ type: "usage" });
      if (outcome.error) this.report({ type: "notice", message: `Claude Code reported an error: ${outcome.error}`, level: "error" });
    }
    this.report({
      type: "turn-settled",
      status,
      ...(status === "error" && outcome?.error ? { error: outcome.error } : {}),
      ...(status === "error" && outcome?.limit ? { limit: outcome.limit } : {}),
    });
  }

  /** The context a turn left, dated, and kept for a thread opened after a restart. */
  private noteContext(usage: UiContextUsage | undefined, at: number): void {
    this.contextUsage = usage ? { ...usage, updatedAt: at, promptCacheTtlMs: PROMPT_CACHE_TTL_MS } : undefined;
    void this.store.setContextUsage(this.threadId, this.cwd, this.contextUsage).catch(() => undefined);
  }

  /**
   * Sends `/compact` as a turn of its own, between turns: the CLI summarises
   * the conversation and reports the size it left. The boundary becomes the
   * transcript's divider; no prompt or reply joins it.
   */
  private async compact(): Promise<void> {
    if (this.restarting) throw new Error("The Claude session is restarting.");
    if (this.turns.length > 0) throw new Error("Claude Code is still working on this thread. Compact it once the turn ends.");
    if (!this.record?.started) throw new Error("This thread has nothing to compact yet.");
    this.admittingPrompts += 1;
    try {
    const permissionLevel = this.options.permissionLevel?.() ?? "full";
    const mode = this.mode === PLAN_MODE ? "plan" : runtimePermissionPolicy(permissionLevel).permissionMode;
    const live = await this.ensureSession(permissionLevel, mode, false, await this.networkLimit());
    const turn: Turn = { translator: new SdkTurnTranslator(this.now, undefined, true), text: COMPACT_COMMAND, compaction: true };
    this.turns.push(turn);
    this.beginTurn(turn);
    await live.session.send(COMPACT_COMMAND, "next");
    await this.persistUsage();
    const outcome = turn.translator.outcome;
    if (outcome?.error) throw new Error(`Claude Code could not compact the conversation: ${outcome.error}`);
    if (!outcome?.compacted) throw new Error(outcome?.texts.join("\n").trim() || "Claude Code did not compact the conversation.");
    } finally { this.admittingPrompts -= 1; }
  }

  /**
   * Claude clears a goal when its check says met, and also after a timeout or
   * an error, with the same frame. Without Tau's own `/goal clear` there is no
   * telling which, so the goal stays as not confirmed, never as met.
   */
  private onActiveGoal(value: { condition: string; iterations: number; last_reason?: string } | null): void {
    if (value) {
      this.setGoal({ condition: value.condition, status: "active", iterations: value.iterations, ...(value.last_reason ? { reason: value.last_reason } : {}), updatedAt: this.now() });
      return;
    }
    if (this.clearingGoal || !this.goal) { this.clearingGoal = false; this.setGoal(undefined); return; }
    this.setGoal({ ...this.goal, status: "unconfirmed", updatedAt: this.now() });
  }

  private setGoal(goal: ClaudeStoredGoal | undefined): void {
    this.goal = goal;
    this.writes = this.writes.then(() => this.store.setGoal(this.threadId, this.cwd, goal)).catch(() => undefined);
    this.report({ type: "goal" });
  }

  private uiGoal(): UiThreadGoal | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    return {
      objective: goal.condition,
      status: goal.status,
      actions: { pause: false, resume: goal.status === "unconfirmed" },
      turns: goal.iterations,
      ...(goal.reason ? { reason: goal.reason } : {}),
      updatedAt: goal.updatedAt,
    };
  }

  /** `/goal clear` as a turn of its own; a running goal turn is stopped first, since Claude has no pause. */
  private async clearGoal(): Promise<void> {
    if (this.restarting) throw new Error("The Claude session is restarting.");
    this.clearingGoal = true;
    if (this.turns.length > 0) await this.abort();
    if (this.turns.length > 0) throw new Error("Claude Code is still working on this thread. End the goal once the turn stops.");
    if (!this.record?.started) { this.setGoal(undefined); return; }
    this.admittingPrompts += 1;
    try {
      const permissionLevel = this.options.permissionLevel?.() ?? "full";
      const mode = this.mode === PLAN_MODE ? "plan" : runtimePermissionPolicy(permissionLevel).permissionMode;
      const live = await this.ensureSession(permissionLevel, mode, false, await this.networkLimit());
      const turn: Turn = { translator: new SdkTurnTranslator(this.now, undefined, true), text: GOAL_CLEAR_COMMAND, compaction: true };
      this.turns.push(turn);
      this.beginTurn(turn);
      await live.session.send(GOAL_CLEAR_COMMAND, "next");
      const outcome = turn.translator.outcome;
      if (outcome?.error) throw new Error(`Claude Code did not end the goal: ${outcome.error}`);
      // "No goal set" is an end as well; a frame may not follow then.
      if (this.clearingGoal) { this.clearingGoal = false; this.setGoal(undefined); }
    } finally { this.admittingPrompts -= 1; }
  }

  /** A row in the transcript that is nobody's message; kept with the thread. */
  private note(text: string): void {
    const message: UiMessage = { id: `claude-notice-${this.now()}-${this.messages.length}`, role: "notice", text, timestamp: this.now() };
    this.messages.push(message);
    this.writes = this.writes.then(() => this.persist([message])).catch(() => undefined);
    this.deliverMessage(message);
  }

  /** What the session says about itself, once per init frame. */
  private noteFacts(facts: SdkTurnTranslator["facts"]): void {
    if (facts.model && facts.model !== this.model) {
      this.model = facts.model;
      void this.store.setObservedModel(this.threadId, this.cwd, facts.model).catch(() => undefined);
    }
    if (facts.effort) this.observedEffort = facts.effort;
  }

  private onExit(live: LiveSession, error: unknown): void {
    if (this.live === live) {
      this.live = undefined;
      for (const event of this.nativeAgents.tracker.interrupt()) this.handleEvent(event);
      this.backgroundTasks.clear();
      this.backgroundTaskLevels = false;
    }
    const status = error ? "error" : "interrupted";
    if (error) this.report({ type: "notice", message: `Claude Code stopped: ${error instanceof Error ? error.message : String(error)}${live.stderr.trim() ? `\n${live.stderr.trim()}` : ""}`, level: "error" });
    for (const turn of this.turns.splice(0)) this.settleTurn(turn, status);
    this.steering = [];
    this.reportQueue();
  }

  private reportQueue(): void {
    this.report({ type: "queue", steering: [...this.steering], followUp: this.turns.slice(1).filter((turn) => !turn.compaction).map((turn) => turn.text) });
  }

  private async persistUsage(): Promise<void> {
    if (this.usage.turns === 0) return;
    const turns = this.unsavedTurns.splice(0);
    await this.store.recordUsage(this.threadId, this.cwd, this.usage, turns);
  }

  /** Claude's questions during a turn go to the workbench; without a dialog surface the SDK gets none. */
  private turnHooks(): ClaudeTurnHooks | undefined {
    if (!this.options.ask) return undefined;
    return {
      canUseTool: (toolName, input, options) => this.canUseTool(toolName, input, options),
      onUserDialog: (request, options) => this.onUserDialog(request, options.signal),
    };
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string; displayName?: string; description?: string; decisionReason?: string; blockedPath?: string },
  ): Promise<PermissionResult> {
    const ask = this.options.ask;
    if (!ask) return { behavior: "deny", message: "Tau cannot ask the user on this host." };
    const stopped = (): PermissionResult => ({ behavior: "deny", message: "The turn was stopped.", interrupt: true });
    if (options.signal.aborted) return stopped();
    if (toolName === "AskUserQuestion") {
      const answers: Record<string, string> = {};
      for (const question of askUserQuestionPrompts(input)) {
        const answer = askUserQuestionAnswer(await ask(question.prompt), question);
        if (options.signal.aborted) return stopped();
        if (answer === undefined) return { behavior: "deny", message: "The user did not answer the question.", decisionClassification: "user_reject" };
        answers[question.question] = answer;
      }
      // The CLI reads answers by the full question text.
      return { behavior: "allow", updatedInput: { ...input, answers }, decisionClassification: "user_temporary" };
    }
    if (toolName === "ExitPlanMode" && this.mode === PLAN_MODE) {
      // Plan mode shows the plan as a card and leaves the next step to the user.
      const plan = typeof input.plan === "string" ? input.plan.trim() : "";
      if (plan) this.handleEvent({ type: "assistant-end", message: { id: `claude-plan-${this.now()}`, role: "assistant", text: proposedPlanText(plan), timestamp: this.now() } });
      return { behavior: "deny", message: PLAN_CAPTURED, decisionClassification: "user_reject" };
    }
    if (toolName === "ExitPlanMode") {
      const answer = await ask(planPrompt());
      if (options.signal.aborted) return stopped();
      return "confirmed" in answer && answer.confirmed
        ? { behavior: "allow", decisionClassification: "user_temporary" }
        : { behavior: "deny", message: PLAN_DECLINED, decisionClassification: "user_reject" };
    }
    const request = { toolName, input, suggestions: options.suggestions, title: options.title, displayName: options.displayName, description: options.description, decisionReason: options.decisionReason, blockedPath: options.blockedPath };
    const answer = await ask(permissionPrompt(request));
    if (options.signal.aborted) return stopped();
    return permissionResultFor(answer, request);
  }

  private async onUserDialog(request: UserDialogRequest, signal: AbortSignal): Promise<UserDialogResult> {
    const ask = this.options.ask;
    if (!ask || request.dialogKind !== "resume_return" || signal.aborted) return { behavior: "cancelled" };
    // The user already chose to compact; asking again would compact twice.
    if (this.turns[0]?.compaction) return { behavior: "completed", result: "continue" };
    const answer = await ask(resumeDialogPrompt());
    if (signal.aborted) return { behavior: "cancelled" };
    const result = resumeDialogResult(answer);
    if (result.behavior === "completed" && result.result === "never") this.options.onResumeQuestionOff?.();
    return result;
  }

  private handleEvent(event: ThreadRuntimeEvent): void {
    if (event.type === "assistant-end") {
      const message = event.message.compaction ? withSummarisedTurns(event.message, this.messages) : event.message;
      this.messages.push(message);
      void this.persist([message]);
      this.deliverMessage(message);
      return;
    }
    this.report(event);
  }

  /** A host with an event route gets the message as an event; an older one as a whole message. */
  private deliverMessage(message: UiMessage): void {
    if (this.options.onEvent) {
      this.options.onEvent(message.role === "user" || (message.role === "notice" && !message.compaction) ? { type: "user-message", message } : { type: "assistant-end", message });
      return;
    }
    this.options.onMessage?.(message);
  }

  private report(event: ThreadRuntimeEvent): void {
    this.options.onEvent?.(event);
  }

  /**
   * Interrupt first; when the turn does not settle in time the session is
   * closed instead (background tasks keep the CLI alive), and the next prompt
   * resumes the same Claude session in a fresh process.
   */
  async abort(): Promise<void> {
    const live = this.live;
    if (!live || live.session.closed) return;
    if (this.turns.length === 0) return;
    await live.session.interrupt().catch(() => undefined);
    const deadline = this.now() + (this.options.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    while (this.turns.length > 0 && this.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25).unref?.());
    }
    if (this.turns.length === 0) return;
    await live.session.close();
  }

  async persist(messages: readonly UiMessage[]): Promise<void> {
    const commands = await this.skills();
    await this.store.appendExchange(this.threadId, this.cwd, messages, {
      knownSkillNames: knownSkillNames(commands),
    });
  }
  async setTitle(title: string, source: ThreadTitleSource): Promise<void> {
    const safeTitle = derivedClaudeTitle(title) ?? "Skill invocation";
    this.title = safeTitle;
    this.titleSource = source;
    await this.store.setTitle(this.threadId, this.cwd, safeTitle, source);
  }
  async waitForIdle(): Promise<void> {
    if (this.turns.length === 0) return;
    await new Promise<void>((resolve) => {
      const check = () => this.turns.length > 0 ? setTimeout(check, 10).unref?.() : resolve();
      check();
    });
  }
  async dispose(): Promise<void> {
    const live = this.live;
    this.live = undefined;
    if (live && !live.session.closed) await live.session.close();
    for (const event of this.nativeAgents.tracker.interrupt()) this.handleEvent(event);
    await this.writes;
  }

  private assertPreparedPrompt(
    text: string,
    prepared: PreparedPrompt,
    commands: readonly UiComposerCommand[],
  ): void {
    validatePreparedPrompt(text, prepared, {
      backendKind: this.kind,
      threadId: this.threadId,
      providerSessionId: this.providerSessionId,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      commands,
    });
  }
}

/** The CLI summarises every turn since its last compaction; the divider names them. */
export function withSummarisedTurns(message: UiMessage, before: readonly UiMessage[]): UiMessage {
  const users = before.filter((entry) => entry.role === "user").length;
  let previous = before.length - 1;
  while (previous >= 0 && before[previous]!.compaction === undefined) previous -= 1;
  const first = before.slice(0, previous + 1).filter((entry) => entry.role === "user").length + 1;
  return users >= first ? { ...message, compaction: { ...message.compaction, turns: { first, last: users } } } : message;
}
