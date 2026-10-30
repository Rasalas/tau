import { appendUsageTurn, mergeTallies, unpricedUsage, type ThreadCatalogView, type UiModel, type UsageTurn } from "tau/host-extension";
import { AcpThreadBackend, type AcpThreadBackendOptions } from "../_acp/thread-backend.js";
import { AcpAgentSession, type AcpPermissionRequest, type AcpPermissionResponse } from "../_acp/session.js";
import { answerElicitation, autoApproval, permissionDialog } from "../_acp/approvals.js";
import { spawnAcpProcess, type AcpProcess, type AcpSpawnInput } from "../_acp/client.js";
import { AcpSessionStore, usageTurnsOf } from "../_acp/session-store.js";
import { withTauServer } from "../_acp/mcp.js";
import type { AcpTurnOutcome } from "../_acp/events.js";
import type { AcpAgentConfig } from "./protocol.js";
import type { HostMcpConnection } from "tau/host-extension";

export interface GenericAcpOptions extends AcpThreadBackendOptions {
  config: AcpAgentConfig;
  store: AcpSessionStore;
  env: NodeJS.ProcessEnv;
  mcp?(): Promise<HostMcpConnection | undefined>;
  spawn?(input: AcpSpawnInput): AcpProcess;
}

/** Every configured agent owns its store; protocol handling stays in the shared ACP implementation. */
export class GenericAcpBackend extends AcpThreadBackend<AcpAgentSession> {
  private chosenModel?: string;
  private modelList: UiModel[] = [];
  private usageTurns: UsageTurn[] = [];
  constructor(threadId: string, cwd: string, private readonly options: GenericAcpOptions) {
    super(threadId, cwd, options.config.name, options.config.id, options.store, options);
    this.capabilities = { ...this.capabilities, catalogWrite: { setModel: async (_provider, id) => {
      const known = await this.models();
      if (!known.some(model => model.id === id)) throw new Error(`${this.agent} offers no model "${id}".`);
      if (this.liveSession()) await this.liveSession()!.setModel(id);
      await options.store.setSelection(threadId, cwd, { model: id });
      this.chosenModel = id;
    }, setThinkingLevel: async level => { if (level !== "default") throw new Error("This ACP agent does not advertise reasoning levels."); } } };
  }
  async start(mode: "create" | "resume"): Promise<void> {
    const record = mode === "resume" ? await this.options.store.get(this.threadId) : undefined;
    if (mode === "resume" && !record) throw new Error(`The ${this.agent} thread is missing.`);
    const saved = record ?? await this.options.store.ensure(this.threadId, this.cwd);
    if (saved.cwd !== this.cwd) throw new Error("This ACP thread belongs to another workspace.");
    this.restoreMessages(saved.messages); this.title = saved.title; this.titleSource = saved.titleSource;
    this.acpSessionId = saved.acpSessionId; this.chosenModel = saved.model;
    this.usageTurns = usageTurnsOf(saved, { provider: this.options.config.id, model: saved.model ?? saved.observedModel });
    this.modelList = (await this.options.store.listModels()).map(model => ({ provider: this.options.config.id, id: model.id, name: model.name }));
    for (const id of this.options.config.models ?? []) if (!this.modelList.some(model => model.id === id)) this.modelList.push({ provider: this.options.config.id, id, name: id });
  }
  async models(): Promise<UiModel[]> {
    const models = this.liveSession()?.modelOptions().map(option => ({ provider: this.options.config.id, id: option.value, name: option.name })) ?? [...this.modelList];
    for (const id of this.options.config.models ?? []) if (!models.some(model => model.id === id)) models.push({ provider: this.options.config.id, id, name: id });
    return models;
  }
  catalogView(): ThreadCatalogView {
    const model = this.liveSession()?.currentModel() ?? this.chosenModel;
    return { ...(model ? { model: { provider: this.options.config.id, id: model, name: this.modelList.find(item => item.id === model)?.name ?? model } } : {}), thinkingLevel: "default", thinkingLevels: [], allTools: [], usage: unpricedUsage(mergeTallies(this.usageTurns)), ...(this.contextUsage ? { contextUsage: this.contextUsage } : {}) };
  }
  protected async beforePrompt(live: AcpAgentSession): Promise<void> {
    const level = this.permissionLevel();
    const modes = live.modeOptions();
    const names = level === "read-only" ? ["read-only", "readonly", "plan"] : level === "full" ? ["allow-all", "allow_all", "bypassPermissions", "yolo", "auto-edit", "agent", "code", "default"] : ["default", "ask", "ask-before-unmatched-actions", "ask_on_request"];
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const mode = names.map(name => modes.find(offered => normalize(offered.value) === normalize(name) || normalize(offered.name) === normalize(name))).find(Boolean);
    // A generic ACP client cannot constrain tools an agent executes without permission callbacks.
    if (level === "read-only" && !mode) throw new Error(`${this.agent} does not advertise a read-only mode. Choose another runtime or change the thread's access level.`);
    if (mode) await live.setMode(mode.value);
    else if (modes.length) throw new Error(`${this.agent} has no mode matching ${level}. Configure an agent that supports this access level.`);
    if (this.chosenModel && live.currentModel() !== this.chosenModel) await live.setModel(this.chosenModel);
  }
  protected async afterTurn(live: AcpAgentSession, _turn: unknown, outcome: AcpTurnOutcome): Promise<void> {
    const model = live.currentModel() ?? this.chosenModel;
    const turn: UsageTurn = { ...outcome.usage, provider: this.options.config.id, ...(model ? { model } : {}), at: this.now(), turns: 1 };
    this.usageTurns = appendUsageTurn(this.usageTurns, turn);
    await this.options.store.recordUsage(this.threadId, this.cwd, unpricedUsage(mergeTallies(this.usageTurns))!, turn);
  }
  protected async openSession(): Promise<AcpAgentSession> {
    const config = this.options.config;
    let session: AcpAgentSession;
    session = new AcpAgentSession({
      agentName: config.name,
      process: (this.options.spawn ?? spawnAcpProcess)({ command: config.command, args: config.args, cwd: this.cwd, env: Object.fromEntries(Object.entries({ ...this.options.env, ...config.env }).filter((pair): pair is [string, string] => typeof pair[1] === "string")) }),
      cwd: this.cwd, clientInfo: { name: "tau", version: "1.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      customModels: config.models, mcpServers: withTauServer([], await this.options.mcp?.()),
      onUpdate: update => this.onUpdate(update), onExit: error => this.onExit(session, error),
      onPermission: request => this.permission(request),
      onElicitation: request => answerElicitation(request, this.sessionAsk(session), config.name),
    });
    try {
      const initialized = await session.initialize();
      if (config.authMethod) {
        if (!initialized.authMethods?.some(method => method.id === config.authMethod)) throw new Error(`${config.name} does not offer authentication method ${config.authMethod}.`);
        await session.authenticate(config.authMethod);
      }
      if (this.acpSessionId) {
        // Never silently replace a saved conversation when an arbitrary agent refuses resume.
        if (initialized.agentCapabilities?.loadSession) await session.loadSession(this.acpSessionId);
        else if (initialized.agentCapabilities?.sessionCapabilities?.resume) await session.resumeSession(this.acpSessionId);
        else throw new Error(`${config.name} cannot resume its saved session. Start a new thread with a handoff.`);
      } else await session.newSession();
      this.acpSessionId = session.sessionId;
      await this.options.store.setAcpSession(this.threadId, this.cwd, session.sessionId);
      this.modelList = session.modelOptions().map(option => ({ provider: config.id, id: option.value, name: option.name }));
      await this.options.store.setModels(this.modelList.map(model => ({ id: model.id, name: model.name, efforts: [] })));
      await this.beforePrompt(session);
      return session;
    } catch (error) { await session.close().catch(() => undefined); throw error; }
  }
  private async permission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    if (this.permissionLevel() === "read-only") return { outcome: { outcome: "cancelled" } };
    if (this.permissionLevel() === "full") return autoApproval(request) ?? { outcome: { outcome: "cancelled" } };
    const dialog = permissionDialog(request, { agent: this.agent });
    return dialog && this.options.ask ? dialog.answerFor(await this.options.ask(dialog.prompt)) : { outcome: { outcome: "cancelled" } };
  }
}
