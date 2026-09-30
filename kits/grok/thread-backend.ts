import {
  DEFAULT_THREAD_MODE as DEFAULT_MODE,
  appendUsageTurn,
  mergeTallies,
  unpricedUsage,
  type ExtensionUiAnswer,
  type ThreadBackendPromptInput,
  type ThreadBackendPromptResult,
  type ThreadCatalogView,
  type UiModel,
  type UiModelBilling,
  type UiThreadUsage,
  type UsageTally,
  type UsageTurn,
} from "tau/host-extension";
import { answerElicitation, autoApproval, permissionDialog } from "../_acp/approvals.js";
import { AcpTurnTranslator, addUsage, type AcpSessionUpdate, type AcpTurnOutcome } from "../_acp/events.js";
import type { AcpContentBlock, AcpElicitationAnswer, AcpElicitationRequest, AcpPermissionRequest, AcpPermissionResponse, AcpSelectOption } from "../_acp/session.js";
import { usageTurnsOf, type AcpStoredModel } from "../_acp/session-store.js";
import { AcpThreadBackend, type AcpThreadBackendOptions, type AcpTurn } from "../_acp/thread-backend.js";
import { DEFAULT_EFFORT, MODEL_PROVIDER, currentEffort, effortsOf, modelStateOf, thinkingLevels } from "./catalog.js";
import { grokAgentArgs } from "./cli.js";
import { ASK_USER_QUESTION, EXIT_PLAN_MODE, PLAN_CAPTURED, askQuestionDialogs, exitPlanMarkdown, initializeCommands, planReply, planWrite, turnCompletedUsage, visibleCommands, type GrokAskAnswer, type GrokTurnUsage } from "./extensions.js";
import type { GrokRuntimeAdapter } from "./runtime-adapter.js";
import type { GrokSession } from "./session.js";
import type { GrokSessionRecord, GrokSessionStore } from "./session-store.js";

/** What the backend needs of a live ACP session; `GrokSession` is the real one. */
export type GrokSessionLike = Pick<GrokSession,
  "closed" | "sessionId" | "initialized" | "setup" | "stderr" | "newSession" | "resumeSession" | "loadSession"
  | "modelOptions" | "modeOptions" | "currentModel" | "setModel" | "setMode" | "prompt" | "cancel" | "close" | "handle">;

export interface GrokSessionInput {
  threadId: string;
  cwd: string;
  /** How the agent starts: its permission mode follows the thread's access. */
  agentArgs: string[];
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
  onElicitation(request: AcpElicitationRequest): Promise<AcpElicitationAnswer>;
  onExit(error: Error | undefined): void;
}

export interface GrokThreadBackendOptions extends AcpThreadBackendOptions {
  adapter: GrokRuntimeAdapter;
  store: GrokSessionStore;
  instance?: string;
  /** Spawns the CLI and signs in; the backend creates or loads the session itself. */
  openSession(input: GrokSessionInput): Promise<GrokSessionLike>;
  /** The login's models as last seen; read when the thread opens. */
  storedModels?(): Promise<readonly AcpStoredModel[]>;
  /** How the instance's login pays: its own account is a subscription, `XAI_API_KEY` the API. */
  billing?: UiModelBilling;
  /** The instance's `GROK_HOME`, where Grok writes its plan files. */
  grokHome?: string;
  /** Prices the thread's turns the way core prices every thread (API 1.12.0). */
  priceUsage?(tallies: readonly UsageTally[]): UiThreadUsage | undefined;
}

export const PLAN_MODE = "plan";
/** Sent with a plan-mode prompt when Grok offers no plan mode of its own to switch to. */
export const PLAN_INSTRUCTIONS = "You are in plan mode: explore and ask, change nothing. When the plan is ready, write it once inside a <proposed_plan> block.";

function findMode(available: readonly AcpSelectOption[], ...aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const match = available.find((option) => option.value.toLowerCase() === alias || option.name.trim().toLowerCase() === alias);
    if (match) return match.value;
  }
  return undefined;
}

/**
 * A Grok thread: one ACP session of `grok agent stdio` per live thread,
 * created on the first turn and loaded by id after a restart
 * (`kits/_acp/thread-backend.ts` runs the turns). The agent's permission mode
 * is set when it starts, so a change of access or plan mode restarts it and
 * loads the session again. Model and effort go through `session/set_model`.
 */
/** Who a thread that kept only its total ran on. */
export function grokUsageOrigin(record: Pick<GrokSessionRecord, "model" | "observedModel">): { provider: string; model?: string } {
  const model = record.observedModel ?? record.model;
  return { provider: MODEL_PROVIDER, ...(model ? { model } : {}) };
}

export class GrokThreadRuntimeBackend extends AcpThreadBackend<GrokSessionLike> {
  declare readonly runtimeAdapter: GrokRuntimeAdapter;
  private usage: UiThreadUsage = AcpTurnTranslator.emptyUsage();
  /** Each finished turn's tokens; `usage` is their running total. */
  private usageTurns: UsageTurn[] = [];
  private chosenModel?: string;
  private chosenEffort?: string;
  private mode = DEFAULT_MODE;
  private observedModel?: string;
  private modelList: AcpStoredModel[] = [];
  /** The agent arguments the live session started with. */
  private spawnedWith?: string;
  /** The effort the live session's model runs at, once Tau set one. */
  private appliedEffort?: { session: GrokSessionLike; effort: string | undefined };
  /** The last plan file Grok wrote this turn, for an `exit_plan_mode` that carries none. */
  private planDraft?: string;
  /** What Grok's `turn_completed` reported for the running turn. */
  private turnUsage?: GrokTurnUsage[];

  constructor(threadId: string, cwd: string, private readonly options: GrokThreadBackendOptions) {
    super(threadId, cwd, "Grok", "grok", options.store, options);
    this.capabilities = {
      ...this.capabilities,
      catalogWrite: {
        setModel: (_provider, id) => this.setModel(id),
        setThinkingLevel: (level) => this.setEffort(level),
      },
      mode: {
        modes: () => [PLAN_MODE],
        current: () => this.mode,
        set: (mode) => this.setMode(mode),
      },
    };
  }

  async start(mode: "create" | "resume"): Promise<void> {
    const store = this.options.store;
    const instance = this.options.instance;
    const record = mode === "create" ? await store.ensure(this.threadId, this.cwd, instance) : await store.get(this.threadId) ?? await store.ensure(this.threadId, this.cwd, instance);
    if (record.cwd !== this.cwd) throw new Error("This Grok thread belongs to another workspace.");
    this.restoreMessages(record.messages);
    this.acpSessionId = record.acpSessionId;
    this.title = record.title;
    this.titleSource = record.titleSource;
    if (record.usage) this.usage = { ...record.usage };
    this.usageTurns = usageTurnsOf(record, grokUsageOrigin(record));
    this.chosenModel = record.model;
    this.chosenEffort = record.effort;
    this.mode = record.mode ?? DEFAULT_MODE;
    this.observedModel = record.observedModel;
    this.modelList = [...await this.options.storedModels?.().catch(() => []) ?? []];
  }

  protected override noteFacts(translator: AcpTurnTranslator): void {
    super.noteFacts(translator);
    this.commands = visibleCommands(this.commands);
  }

  private currentModel(): string | undefined {
    return this.chosenModel ?? this.liveSession()?.currentModel() ?? this.observedModel;
  }

  /** The efforts a model offers: from the live session's model state, else from the stored list. */
  private efforts(model = this.currentModel()): string[] {
    const state = modelStateOf(this.liveSession()?.setup?.models);
    const live = state?.availableModels.find((entry) => entry.modelId === model);
    if (live) return effortsOf(live);
    return this.modelList.find((entry) => entry.id === model)?.efforts ?? [];
  }

  catalogView(): ThreadCatalogView {
    const current = this.currentModel();
    const name = this.liveSession()?.modelOptions().find((option) => option.value === current)?.name ?? this.modelList.find((model) => model.id === current)?.name;
    const tallies = mergeTallies(this.usageTurns);
    const usage = this.options.priceUsage ? this.options.priceUsage(tallies) : unpricedUsage(tallies);
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
    if (known.length > 0 && !known.includes(id)) throw new Error(`Grok offers no model "${id}".`);
    this.chosenModel = id;
    const reset = this.chosenEffort !== undefined && !this.efforts(id).includes(this.chosenEffort);
    if (reset) this.chosenEffort = undefined;
    await this.options.store.setSelection(this.threadId, this.cwd, { model: id, ...(reset ? { effort: null } : {}) });
  }

  private async setEffort(level: string): Promise<void> {
    if (level === DEFAULT_EFFORT) this.chosenEffort = undefined;
    else {
      const efforts = this.efforts();
      if (efforts.length && !efforts.includes(level)) throw new Error(`This model has no reasoning effort "${level}".`);
      this.chosenEffort = level;
    }
    await this.options.store.setSelection(this.threadId, this.cwd, { effort: this.chosenEffort ?? null });
  }

  private async setMode(mode: string): Promise<void> {
    if (mode !== PLAN_MODE && mode !== DEFAULT_MODE) throw new Error(`Grok offers no "${mode}" mode.`);
    this.mode = mode;
    await this.options.store.setSelection(this.threadId, this.cwd, { mode: mode === DEFAULT_MODE ? null : mode });
  }

  /** Read-only and plan mode refuse every change Grok asks for. */
  private restricted(): boolean {
    return this.permissionLevel() === "read-only" || this.mode === PLAN_MODE;
  }

  private agentArgs(): string[] {
    return grokAgentArgs(this.permissionLevel(), this.restricted());
  }

  override async prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult> {
    if (/^\s*\/always-approve(?:\s|$)/iu.test(input.text)) throw new Error("Change what Grok may do with Tau's access level, not /always-approve.");
    return super.prompt(input);
  }

  /** A session started with other permissions is stopped and loaded again under the thread's current ones. */
  protected override async ensureSession(): Promise<GrokSessionLike> {
    const live = this.liveSession();
    if (live && this.spawnedWith !== this.agentArgs().join(" ")) {
      this.live = undefined;
      await live.close().catch(() => undefined);
    }
    return super.ensureSession();
  }

  protected override async beforePrompt(live: GrokSessionLike, turn: AcpTurn): Promise<void> {
    this.planDraft = undefined;
    this.turnUsage = undefined;
    await this.applyModel(live);
    const modes = live.modeOptions();
    const native = this.mode === PLAN_MODE ? findMode(modes, "plan") : findMode(modes, "default", "agent", "code");
    if (native) await live.setMode(native);
    else if (this.mode === PLAN_MODE && !/^\s*\//u.test(turn.text)) turn.blocks = [...turn.blocks, { type: "text", text: PLAN_INSTRUCTIONS } satisfies AcpContentBlock];
  }

  /** The chosen model and effort; an effort goes with the model as `_meta.reasoningEffort`, the default sends none. */
  private async applyModel(live: GrokSessionLike): Promise<void> {
    const current = live.currentModel();
    const target = this.chosenModel && live.modelOptions().some((option) => option.value === this.chosenModel) ? this.chosenModel : current;
    if (!target) return;
    const applied = this.appliedEffort?.session === live ? this.appliedEffort.effort : currentEffort(modelStateOf(live.setup?.models));
    const effort = this.chosenEffort && this.efforts(target).includes(this.chosenEffort) ? this.chosenEffort : undefined;
    const changed = target !== current;
    if (!changed && (effort === undefined || effort === applied)) return;
    await live.setModel(target, effort ? { reasoningEffort: effort } : undefined);
    this.appliedEffort = { session: live, effort: effort ?? (changed ? undefined : applied) };
  }

  protected override onUpdate(update: AcpSessionUpdate): void {
    if (this.postedTurn()) {
      const usage = turnCompletedUsage(update);
      if (usage) this.turnUsage = usage;
      const plan = planWrite(update, this.options.grokHome);
      if (plan !== undefined) this.planDraft = plan;
    }
    super.onUpdate(update);
  }

  protected override async afterTurn(live: GrokSessionLike, _turn: AcpTurn, outcome: AcpTurnOutcome): Promise<void> {
    const model = (live.closed ? undefined : live.currentModel()) ?? this.chosenModel ?? this.observedModel;
    const at = this.now();
    const { turns: _turns, costUsd: _cost, ...reported } = outcome.usage;
    const shares = this.turnUsage ?? [{ ...reported, costUsd: 0 }];
    const billing = this.options.billing;
    for (const [index, share] of shares.entries()) {
      const finished: UsageTurn = { provider: MODEL_PROVIDER, ...(share.model ?? model ? { model: share.model ?? model } : {}), ...(billing ? { billing } : {}), inputTokens: share.inputTokens, outputTokens: share.outputTokens, cacheReadTokens: share.cacheReadTokens, cacheWriteTokens: share.cacheWriteTokens, totalTokens: share.totalTokens, costUsd: share.costUsd, turns: index === 0 ? 1 : 0, at };
      this.usageTurns = appendUsageTurn(this.usageTurns, finished);
      this.usage = addUsage(this.usage, finished);
      await this.options.store.recordUsage(this.threadId, this.cwd, this.usage, finished);
    }
    if (model && model !== this.observedModel && !live.closed) {
      this.observedModel = model;
      await this.options.store.setObservedModel(this.threadId, this.cwd, model);
    }
  }

  /** The CLI, signed in; the stored session loaded (or resumed) once, a gone one started afresh. */
  protected async openSession(): Promise<GrokSessionLike> {
    if (this.permissionLevel() === "ask" && !this.options.ask) throw new Error("Grok cannot ask for approvals on this host; choose read-only or full access.");
    await this.options.store.ensure(this.threadId, this.cwd, this.options.instance);
    const agentArgs = this.agentArgs();
    let session: GrokSessionLike | undefined;
    session = await this.options.openSession({
      threadId: this.threadId,
      cwd: this.cwd,
      agentArgs,
      onUpdate: (update) => this.onUpdate(update),
      onPermission: (request) => this.onPermission(request),
      onElicitation: (request) => answerElicitation(request, this.options.ask, "Grok"),
      onExit: (error) => this.onExit(session, error),
    });
    try {
      for (const method of ASK_USER_QUESTION) session.handle(method, (params) => this.askQuestion(params));
      for (const method of EXIT_PLAN_MODE) session.handle(method, (params) => this.exitPlan(params));
      const commands = initializeCommands(session.initialized);
      if (commands.length) this.commands = commands;
      await this.restoreSession(session);
      if (session.sessionId && session.sessionId !== this.acpSessionId) {
        this.acpSessionId = session.sessionId;
        await this.options.store.setAcpSession(this.threadId, this.cwd, session.sessionId);
      }
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    this.spawnedWith = agentArgs.join(" ");
    return session;
  }

  /** `session/load` first, as Grok's own client does; `session/resume` where only that is offered. */
  private async restoreSession(session: GrokSessionLike): Promise<void> {
    const stored = this.acpSessionId;
    const capabilities = session.initialized?.agentCapabilities;
    if (stored && (capabilities?.loadSession || capabilities?.sessionCapabilities?.resume)) {
      try {
        if (capabilities.loadSession) await session.loadSession(stored);
        else await session.resumeSession(stored);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/exited|closed/iu.test(message)) throw error;
      }
    }
    if (stored) {
      this.report({ type: "notice", message: "Grok no longer has this conversation; a new one starts here.", level: "warning" });
      await this.options.store.setAcpSession(this.threadId, this.cwd, undefined);
      this.acpSessionId = undefined;
    }
    await session.newSession();
  }

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    if (this.restricted()) {
      const reject = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    if (this.permissionLevel() === "full") return autoApproval(request) ?? { outcome: { outcome: "cancelled" } };
    const ask = this.options.ask;
    const dialog = permissionDialog(request, { agent: "Grok" });
    if (!ask || !dialog) return { outcome: { outcome: "cancelled" } };
    return dialog.answerFor(await ask(dialog.prompt).catch((): ExtensionUiAnswer => ({ cancelled: true })));
  }

  private async askQuestion(params: unknown): Promise<GrokAskAnswer> {
    const ask = this.options.ask;
    if (!ask) return { outcome: "cancelled" };
    const dialogs = askQuestionDialogs(params);
    const replies: ExtensionUiAnswer[] = [];
    for (const prompt of dialogs.prompts) {
      const reply = await ask(prompt).catch((): ExtensionUiAnswer => ({ cancelled: true }));
      replies.push(reply);
      if ("cancelled" in reply) break;
    }
    return dialogs.answer(replies);
  }

  /** The plan becomes Plan Kit's card; Grok's own approval is closed so the turn ends, and building it is the next prompt. */
  private exitPlan(params: unknown): typeof PLAN_CAPTURED {
    const turn = this.postedTurn();
    if (turn) this.emit(turn.translator.reply(planReply(exitPlanMarkdown(params, this.planDraft))));
    this.planDraft = undefined;
    return PLAN_CAPTURED;
  }
}
