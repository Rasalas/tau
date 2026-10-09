import {
  appendUsageTurn,
  mergeTallies,
  unpricedUsage,
  type RuntimePermissionLevel,
  type ThreadCatalogView,
  type UiModel,
  type UiModelBilling,
  type UiThreadUsage,
  type UsageTally,
  type UsageTurn,
} from "tau/host-extension";
import { AcpTurnTranslator, addUsage, type AcpPromptResponse, type AcpSessionUpdate, type AcpTurnOutcome } from "../_acp/events.js";
import type { AcpContentBlock, AcpElicitationAnswer, AcpElicitationRequest, AcpInitializeResult, AcpPermissionRequest, AcpPermissionResponse, AcpSelectOption, AcpSessionSetup } from "../_acp/session.js";
import { modelProvider } from "../_acp/model-provider.js";
import { promptBlocks } from "../_acp/thread.js";
import { AcpThreadBackend, type AcpThreadBackendOptions, type AcpTurn } from "../_acp/thread-backend.js";
import { answerElicitation, modeForLevel, permissionDialog } from "./approvals.js";
import type { AuthorizationLink } from "./profile.js";
import type { AntigravityRuntimeAdapter } from "./runtime-adapter.js";
import type { AntigravitySessionRecord, AntigravitySessionStore } from "./session-store.js";
import { usageTurnsOf } from "../_acp/session-store.js";

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

export interface AntigravityThreadBackendOptions extends AcpThreadBackendOptions {
  adapter: AntigravityRuntimeAdapter;
  store: AntigravitySessionStore;
  /** Spawns and shakes hands with the agent; the backend creates or resumes the session itself. */
  openSession(input: AntigravitySessionInput): Promise<AntigravitySessionLike>;
  /** The link the agent wants opened for Google's sign-in. */
  onSignIn?(link: AuthorizationLink, threadId: string): void;
  /** Models to list before a session exists. */
  cachedModels?(): Promise<AcpSelectOption[]>;
  /** What the agent offers this account, reported once a session exists so the next start knows it. */
  onModels?(models: readonly AcpSelectOption[]): void;
  projectName: string;
  branch?: string;
  /** Prices the thread's turns the way core prices every thread (API 1.12.0). */
  priceUsage?(tallies: readonly UsageTally[]): UiThreadUsage | undefined;
  /** How the sign-in in use pays, stamped on each turn so no other runtime's login decides it. */
  billing?(): UiModelBilling | undefined;
}

/** Google serves every model on Antigravity; one of Google's is this provider's. */
export const MODEL_PROVIDER = "google";

/** A model's provider: its maker's where the name tells (Claude on Antigravity is Anthropic's), else Google's. */
export function antigravityModelProvider(model: { id: string; name?: string }): string {
  return modelProvider(model, MODEL_PROVIDER);
}

/** Who a thread that kept only its total ran on. */
export function antigravityUsageOrigin(record: Pick<AntigravitySessionRecord, "model" | "observedModel">): { provider: string; model?: string } {
  const model = record.observedModel ?? record.model;
  return model ? { provider: antigravityModelProvider({ id: model }), model } : { provider: MODEL_PROVIDER };
}
const RESUME_MISSING = /(?:session|conversation)[^\n]*(?:not found|does not exist|unknown|missing|invalid|expired)|(?:no|cannot|could not)\s+(?:find\s+|load\s+|resume\s+)?(?:the\s+)?(?:session|conversation)/iu;

export { promptBlocks };

/**
 * Antigravity's complete thread owner: one ACP session per live thread,
 * created on the first turn and resumed by id after a restart
 * (`kits/_acp/thread-backend.ts` runs the turns). The agent's questions and
 * approvals go to the workbench.
 */
export class AntigravityThreadRuntimeBackend extends AcpThreadBackend<AntigravitySessionLike> {
  declare readonly kind: "antigravity";
  declare readonly runtimeAdapter: AntigravityRuntimeAdapter;
  /** The sign-in reports its own trouble; a failed start needs no second notice. */
  protected override readonly noticeOnStartFailure = false;
  private readonly agyStore: AntigravitySessionStore;
  private usage: UiThreadUsage = AcpTurnTranslator.emptyUsage();
  /** Each finished turn's tokens; `usage` is their running total. */
  private usageTurns: UsageTurn[] = [];
  private chosenModel?: string;
  /** The model the thread last ran on, for the picker before a session exists. */
  private observedModel?: string;
  /** The account's models by id, so a thread can name its model without a live session. */
  private modelNames = new Map<string, string>();
  private appliedLevel?: RuntimePermissionLevel;

  constructor(threadId: string, cwd: string, private readonly options: AntigravityThreadBackendOptions) {
    super(threadId, cwd, "Antigravity", "antigravity", options.store, options);
    this.agyStore = options.store;
    this.capabilities = {
      ...this.capabilities,
      catalogWrite: {
        setModel: (_provider, id) => this.setModel(id),
        setThinkingLevel: async () => { throw new Error("Antigravity chooses effort with the model; pick a model variant instead."); },
      },
    };
  }

  async start(mode: "create" | "resume"): Promise<void> {
    const record = mode === "create"
      ? await this.agyStore.ensure(this.threadId, this.cwd)
      : await this.agyStore.get(this.threadId) ?? await this.agyStore.ensure(this.threadId, this.cwd);
    if (record.cwd !== this.cwd) throw new Error("Antigravity session belongs to another workspace.");
    this.restoreMessages(record.messages);
    this.acpSessionId = record.acpSessionId;
    this.title = record.title;
    this.titleSource = record.titleSource;
    if (record.usage) this.usage = { ...record.usage };
    this.usageTurns = usageTurnsOf(record, antigravityUsageOrigin(record));
    this.chosenModel = record.model;
    this.observedModel = record.observedModel;
    this.rememberModels(await this.options.cachedModels?.() ?? []);
  }

  private rememberModels(models: readonly AcpSelectOption[]): void {
    for (const model of models) this.modelNames.set(model.value, model.name.trim() || model.value);
  }

  catalogView(): ThreadCatalogView {
    const live = this.liveSession();
    const current = live?.currentModel() ?? this.chosenModel ?? this.observedModel;
    const named = live?.modelOptions().find((option) => option.value === current) ?? (current ? { name: this.modelNames.get(current) } : undefined);
    const tallies = mergeTallies(this.usageTurns);
    const usage = this.options.priceUsage ? this.options.priceUsage(tallies) : unpricedUsage(tallies);
    return {
      ...(current ? { model: { provider: this.providerOf(current, named?.name), id: current, name: named?.name ?? current } } : {}),
      thinkingLevel: "default",
      thinkingLevels: [],
      allTools: [],
      ...(usage ? { usage } : {}),
      ...(this.contextUsage ? { contextUsage: { ...this.contextUsage } } : {}),
    };
  }

  async models(): Promise<UiModel[]> {
    const live = this.liveSession();
    const options = live ? live.modelOptions() : await this.options.cachedModels?.() ?? [];
    return options.map((option) => ({ provider: antigravityModelProvider({ id: option.value, name: option.name }), id: option.value, name: option.name.trim() || option.value }));
  }

  private providerOf(id: string, name = this.liveSession()?.modelOptions().find((option) => option.value === id)?.name ?? this.modelNames.get(id)): string {
    return antigravityModelProvider({ id, ...(name ? { name } : {}) });
  }

  private async setModel(id: string): Promise<void> {
    const live = this.liveSession();
    if (live) await live.setModel(id);
    this.chosenModel = id;
    await this.agyStore.setModel(this.threadId, this.cwd, id);
  }

  protected override async beforePrompt(live: AntigravitySessionLike): Promise<void> {
    await this.applyLevel(live);
  }

  protected override async afterTurn(live: AntigravitySessionLike, turn: AcpTurn, outcome: AcpTurnOutcome): Promise<void> {
    this.usage = addUsage(this.usage, outcome.usage);
    // The agent reports a session's cost as a running sum; a turn's is what it grew by, or all of it in a new session.
    const reported = turn.translator.facts.sessionCostUsd;
    const before = this.sessionCostUsd ?? 0;
    const cost = reported === undefined ? 0 : reported >= before ? reported - before : reported;
    const model = (live.closed ? undefined : live.currentModel()) ?? this.chosenModel ?? this.observedModel;
    const billing = this.options.billing?.();
    const finished: UsageTurn = { provider: model ? this.providerOf(model) : MODEL_PROVIDER, ...(model ? { model } : {}), ...(billing ? { billing } : {}), ...outcome.usage, costUsd: cost, turns: 1, at: this.now() };
    this.usageTurns = appendUsageTurn(this.usageTurns, finished);
    await this.agyStore.recordUsage(this.threadId, this.cwd, this.usage, finished);
  }

  /** The live session, spawned on demand; the stored id is resumed once and a gone session started afresh. */
  protected async openSession(): Promise<AntigravitySessionLike> {
    const record = await this.agyStore.ensure(this.threadId, this.cwd);
    let session: AntigravitySessionLike | undefined;
    session = await this.options.openSession({
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
          await this.agyStore.clearAcpSession(this.threadId, this.cwd);
          await session.newSession();
        }
      } else {
        await session.newSession();
      }
      if (session.sessionId) {
        this.acpSessionId = session.sessionId;
        await this.agyStore.setAcpSession(this.threadId, this.cwd, session.sessionId);
      }
      const models = session.modelOptions();
      if (models.length > 0) {
        this.rememberModels(models);
        this.options.onModels?.(models);
      }
      const running = session.currentModel();
      if (running && running !== this.observedModel) {
        this.observedModel = running;
        await this.agyStore.setObservedModel(this.threadId, this.cwd, running);
      }
      if (this.chosenModel && session.modelOptions().some((option) => option.value === this.chosenModel)) await session.setModel(this.chosenModel);
      this.appliedLevel = undefined;
      await this.applyLevel(session);
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    return session;
  }

  /** The access level as a session mode, applied when it changed. */
  private async applyLevel(session: AntigravitySessionLike): Promise<void> {
    const level = this.permissionLevel();
    if ((level === "ask" || level === "auto") && !this.options.ask) throw new Error("Antigravity cannot ask for approvals on this host; choose read-only or full access.");
    if (this.appliedLevel === level) return;
    const mode = modeForLevel(level, session.modeOptions());
    if (mode) await session.setMode(mode);
    this.appliedLevel = level;
  }

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    const ask = this.options.ask;
    const dialog = permissionDialog(request);
    if (!ask || !dialog) return { outcome: { outcome: "cancelled" } };
    return dialog.answerFor(await ask(dialog.prompt));
  }
}
