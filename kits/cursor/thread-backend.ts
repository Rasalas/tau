import {
  DEFAULT_THREAD_MODE as DEFAULT_MODE,
  type ExtensionUiAnswer,
  type RuntimePermissionLevel,
  type ThreadCatalogView,
  type UiModel,
  type UiThreadUsage,
} from "tau/host-extension";
import { answerElicitation, autoApproval, permissionDialog } from "../_acp/approvals.js";
import { AcpTurnTranslator, addUsage, type AcpSessionUpdate, type AcpTurnOutcome } from "../_acp/events.js";
import { configOptionValues, type AcpAgentSession, type AcpElicitationAnswer, type AcpElicitationRequest, type AcpPermissionRequest, type AcpPermissionResponse, type AcpSelectOption } from "../_acp/session.js";
import { AcpThreadBackend, type AcpThreadBackendOptions, type AcpTurn, type AcpTurnVerdict } from "../_acp/thread-backend.js";
import { DEFAULT_EFFORT, cursorModelProvider, effortOption, thinkingLevels } from "./catalog.js";
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

export interface CursorThreadBackendOptions extends AcpThreadBackendOptions {
  adapter: CursorRuntimeAdapter;
  store: CursorSessionStore;
  instance?: string;
  /** Spawns the CLI and signs in; the backend creates or loads the session itself. */
  openSession(input: CursorSessionInput): Promise<CursorSessionLike>;
  /** The account's models as last seen; read when the thread opens. */
  storedModels?(): Promise<readonly CursorStoredModel[]>;
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
 * the first turn and loaded by id after a restart (`kits/_acp/thread-backend.ts`
 * runs the turns). Model, effort and mode are applied before each turn;
 * approvals, questions and forms go to the workbench, a plan becomes a plan card.
 */
export class CursorThreadRuntimeBackend extends AcpThreadBackend<CursorSessionLike> {
  declare readonly runtimeAdapter: CursorRuntimeAdapter;
  private readonly cursorStore: CursorSessionStore;
  private usage: UiThreadUsage = AcpTurnTranslator.emptyUsage();
  private chosenModel?: string;
  private chosenEffort?: string;
  private mode = DEFAULT_MODE;
  private observedModel?: string;
  private modelList: CursorStoredModel[] = [];

  constructor(threadId: string, cwd: string, private readonly options: CursorThreadBackendOptions) {
    super(threadId, cwd, "Cursor", "cursor", options.store, options);
    this.cursorStore = options.store;
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
    const instance = this.options.instance;
    const record = mode === "create" ? await this.cursorStore.ensure(this.threadId, this.cwd, instance) : await this.cursorStore.get(this.threadId) ?? await this.cursorStore.ensure(this.threadId, this.cwd, instance);
    if (record.cwd !== this.cwd) throw new Error("This Cursor thread belongs to another workspace.");
    this.restoreMessages(record.messages);
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
      ...(current ? { model: { provider: cursorModelProvider({ id: current, ...(name ? { name } : {}) }), id: current, name: name ?? current } } : {}),
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
    return options.map((option) => ({ provider: cursorModelProvider(option), id: option.id, name: option.name.trim() || option.id }));
  }

  private async setModel(id: string): Promise<void> {
    const known = this.liveSession()?.modelOptions().map((option) => option.value) ?? this.modelList.map((model) => model.id);
    if (known.length > 0 && !known.includes(id)) throw new Error(`Cursor offers no model "${id}".`);
    this.chosenModel = id;
    const reset = this.chosenEffort !== undefined && !this.efforts().includes(this.chosenEffort);
    if (reset) this.chosenEffort = undefined;
    await this.cursorStore.setSelection(this.threadId, this.cwd, { model: id, ...(reset ? { effort: null } : {}) });
  }

  private async setEffort(level: string): Promise<void> {
    if (level === DEFAULT_EFFORT) this.chosenEffort = undefined;
    else {
      const efforts = this.efforts();
      if (efforts.length && !efforts.includes(level)) throw new Error(`This model has no reasoning effort "${level}".`);
      this.chosenEffort = level;
    }
    await this.cursorStore.setSelection(this.threadId, this.cwd, { effort: this.chosenEffort ?? null });
  }

  private async setMode(mode: string): Promise<void> {
    if (mode !== PLAN_MODE && mode !== DEFAULT_MODE) throw new Error(`Cursor offers no "${mode}" mode.`);
    this.mode = mode;
    await this.cursorStore.setSelection(this.threadId, this.cwd, { mode: mode === DEFAULT_MODE ? null : mode });
  }

  /** Model, effort and mode the thread wants, set on the session where they differ. */
  protected override async beforePrompt(live: CursorSessionLike): Promise<void> {
    if (this.chosenModel && live.modelOptions().some((option) => option.value === this.chosenModel)) await live.setModel(this.chosenModel);
    const effort = effortOption(live.configOptions);
    if (effort && this.chosenEffort && configOptionValues(effort).some((entry) => entry.value === this.chosenEffort)) await live.setConfigOption(effort.id, this.chosenEffort);
    const mode = cursorMode(this.mode, this.permissionLevel(), live.modeOptions());
    if (mode) await live.setMode(mode);
  }

  protected override async afterTurn(live: CursorSessionLike, _turn: AcpTurn, outcome: AcpTurnOutcome): Promise<AcpTurnVerdict | void> {
    this.usage = addUsage(this.usage, outcome.usage);
    await this.cursorStore.recordUsage(this.threadId, this.cwd, this.usage);
    const running = live.currentModel();
    if (running && running !== this.observedModel) {
      this.observedModel = running;
      await this.cursorStore.setObservedModel(this.threadId, this.cwd, running);
    }
    const failure = outcome.cancelled ? undefined : transportFailure(outcome.texts.join("\n"));
    if (failure) return { status: "error", error: `Cursor could not reach its server: ${failure}` };
  }

  /** The CLI, signed in; the stored session loaded (or resumed) once, a gone one started afresh. */
  protected async openSession(): Promise<CursorSessionLike> {
    if (["ask", "auto"].includes(this.permissionLevel()) && !this.options.ask) throw new Error("Cursor cannot ask for approvals on this host; choose read-only or full access.");
    await this.cursorStore.ensure(this.threadId, this.cwd, this.options.instance);
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
        await this.cursorStore.setAcpSession(this.threadId, this.cwd, session.sessionId);
      }
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
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
      await this.cursorStore.setAcpSession(this.threadId, this.cwd, undefined);
      this.acpSessionId = undefined;
    }
    await session.newSession();
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
    const turn = this.postedTurn();
    if (turn) this.emit(turn.translator.reply(planReply(request)));
    return { outcome: { outcome: "accepted" } };
  }

  private onExtension(method: string, params: unknown): void {
    const turn = this.postedTurn();
    const card = extensionCard(method, params);
    if (!turn || !card) return;
    this.emit(turn.translator.finishedTool(card));
  }
}
