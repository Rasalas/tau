import type {
  PreparedPrompt,
  RuntimeCapabilities,
  ThreadBackendKind,
  UiComposerCommand,
  UiMessage,
  UiModel,
  UiSession,
  UiSkillInvocation,
  UiToolRun,
} from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { canonicalSkillName, prepareSkillPrompt, skillInvocationCommand, visibleSkillEnvelopeText } from "./skill-invocation.js";
import { assertClaudePermissionPolicySupported, runtimePermissionPolicy, type AgentRuntimeAdapter, type ClaudeCodeAgentRuntimeAdapter, type RuntimePermissionPolicy } from "./runtime-adapters.js";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ClaudeRuntimeSessionStore, type ClaudeTitleSource } from "./claude-runtime-store.js";

export interface ThreadBackendPromptInput {
  text: string;
  delivery: "prompt" | "steer" | "followUp";
  clientMessageId?: string;
  prepared?: PreparedPrompt;
  signal?: AbortSignal;
}

export interface ThreadBackendCatalog {
  models: UiModel[];
  model?: UiModel;
  runtimeCapabilities: RuntimeCapabilities;
  thinkingLevel: string;
  thinkingLevels: string[];
  allTools: Array<{ name: string; description: string }>;
  composerCommands: UiComposerCommand[];
}

export interface ThreadBackendSnapshot {
  backendKind: ThreadBackendKind;
  sessionId: string;
  cwd: string;
  title?: string;
  titleSource?: ClaudeTitleSource;
  messages: UiMessage[];
  isStreaming: boolean;
  activeTools: string[];
  model?: UiModel;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  catalog: ThreadBackendCatalog;
}

export interface ThreadRuntimeBackend {
  /** Runtime owner for this thread. This value never changes while live. */
  readonly kind: ThreadBackendKind;
  readonly runtimeAdapter: AgentRuntimeAdapter;
  readonly sessionId: string;
  readonly cwd: string;

  /** Lifecycle operations are owned by the backend, not by the host's Pi carrier. */
  create(): Promise<void>;
  resume(): Promise<void>;
  index(): Promise<UiSession>;
  detail(): Promise<ThreadBackendSnapshot>;
  transcript(cursor?: string): Promise<UiMessage[]>;
  catalog(): Promise<ThreadBackendCatalog>;
  skills(): Promise<UiComposerCommand[]>;
  preparePrompt(text: string, skillName?: string): Promise<PreparedPrompt>;
  prompt(input: ThreadBackendPromptInput): Promise<{ assistantText?: string }>;
  abort(): Promise<void>;
  persist(messages: readonly UiMessage[]): Promise<void>;
  setTitle(title: string, source: ClaudeTitleSource): Promise<void>;
  setModel(provider: string, id: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  compact(): Promise<void>;
  isStreaming(): boolean;
  isIdle(): boolean;
  dispose(): Promise<void>;
}

export interface PiThreadBackendOptions {
  commands(): UiComposerCommand[];
  mapMessages(messages: readonly unknown[]): UiMessage[];
  index(): Promise<UiSession>;
}

function modelOf(model: { provider: string; id: string; name?: string } | undefined): UiModel | undefined {
  return model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : undefined;
}

function derivedClaudeTitle(text: string): string | undefined {
  const visible = visibleSkillEnvelopeText(text) ?? (/<skill\b|\blocation\s*=/iu.test(text) ? "Skill invocation" : text);
  const firstLine = visible.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  if (!firstLine || /<skill\b|\blocation\s*=/iu.test(firstLine)) return undefined;
  const title = firstLine.replace(/(?:\*\*|__|~~|`)+/gu, "").replace(/[.!?:;]+$/u, "").trim();
  return title ? title.slice(0, 80) : undefined;
}

/** Deep adapter around the Pi SDK. It keeps Pi transcript/context state in Pi. */
export class PiThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind = "pi" as const;
  readonly runtimeAdapter: AgentRuntimeAdapter;
  private lifecycle: "new" | "created" | "resumed" | "disposed" = "new";

  constructor(
    private readonly runtime: AgentSessionRuntime,
    adapter: AgentRuntimeAdapter,
    private readonly options: PiThreadBackendOptions,
  ) {
    if (adapter.id !== "pi") throw new Error("Pi backend requires the Pi runtime adapter.");
    this.runtimeAdapter = adapter;
  }

  get session(): AgentSession { return this.runtime.session; }
  get sessionId(): string { return this.session.sessionId; }
  get cwd(): string { return this.runtime.cwd; }

  async create(): Promise<void> {
    if (this.lifecycle === "disposed") throw new Error("The Pi runtime backend has been disposed.");
    if (this.lifecycle === "new") this.lifecycle = "created";
  }
  async resume(): Promise<void> {
    if (this.lifecycle === "disposed") throw new Error("The Pi runtime backend has been disposed.");
    if (this.lifecycle === "new") this.lifecycle = "resumed";
  }
  async index(): Promise<UiSession> { return this.options.index(); }
  async transcript(): Promise<UiMessage[]> { return this.options.mapMessages(this.session.messages); }
  async skills(): Promise<UiComposerCommand[]> { return this.options.commands(); }

  async catalog(): Promise<ThreadBackendCatalog> {
    return {
      models: (await this.session.modelRuntime.getAvailable()).map((model) => modelOf(model)!),
      model: modelOf(this.session.model),
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      thinkingLevel: this.session.thinkingLevel,
      thinkingLevels: this.session.getAvailableThinkingLevels(),
      allTools: this.session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
      composerCommands: await this.skills(),
    };
  }

  async detail(): Promise<ThreadBackendSnapshot> {
    const catalog = await this.catalog();
    return {
      backendKind: this.kind,
      sessionId: this.sessionId,
      cwd: this.cwd,
      title: this.session.sessionName,
      messages: await this.transcript(),
      isStreaming: this.session.isStreaming,
      activeTools: this.session.getActiveToolNames(),
      model: catalog.model,
      catalog,
      contextUsage: (() => {
        const usage = this.session.getContextUsage();
        return usage && usage.tokens !== null && usage.percent !== null
          ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
          : undefined;
      })(),
    };
  }

  async preparePrompt(text: string, skillName?: string): Promise<PreparedPrompt> {
    const commands = await this.skills();
    const effectiveCommands = commands;
    if (skillName && !knownSkillNames(commands).has(canonicalSkillName(skillName))) {
      throw new Error(`The selected skill '${skillName}' is no longer available in this runtime.`);
    }
    const prepared = prepareSkillPrompt(text, this.runtimeAdapter, effectiveCommands);
    return {
      sessionId: this.sessionId,
      backendKind: this.kind,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, [...knownSkillNames(effectiveCommands)]),
    };
  }

  async prompt(input: ThreadBackendPromptInput): Promise<{ assistantText?: string }> {
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    if (prepared.backendKind !== this.kind || (prepared.sessionId !== undefined && prepared.sessionId !== this.sessionId)) throw new Error("Prepared prompt belongs to another runtime.");
    if (input.delivery === "steer") await this.session.steer(prepared.runtimeText);
    else if (input.delivery === "followUp") await this.session.followUp(prepared.runtimeText);
    else await this.session.prompt(prepared.runtimeText);
    return {};
  }

  async abort(): Promise<void> { await this.session.abort(); }
  async persist(messages: readonly UiMessage[]): Promise<void> {
    if (this.lifecycle === "disposed") throw new Error("The Pi runtime backend has been disposed.");
    if (this.lifecycle === "new") await this.resume();
    // SessionManager is Pi's durable writer. Reading its active branch here
    // gives callers an explicit completion point without duplicating entries
    // or attempting to serialize Pi's private message format in Tau.
    if (messages.length > 0 && !Array.isArray(this.session.sessionManager.getBranch())) {
      throw new Error("Pi did not expose a durable session branch.");
    }
  }
  async setTitle(title: string): Promise<void> { this.session.setSessionName(title); }
  async setModel(provider: string, id: string): Promise<void> {
    const model = this.session.modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
    await this.session.setModel(model);
  }
  async setThinkingLevel(level: string): Promise<void> { this.session.setThinkingLevel(level as never); }
  async compact(): Promise<void> { await this.session.compact(); }
  isStreaming(): boolean { return this.session.isStreaming; }
  isIdle(): boolean { return this.session.isIdle; }
  async dispose(): Promise<void> {
    if (this.lifecycle === "disposed") return;
    this.lifecycle = "disposed";
    await this.runtime.dispose();
  }
}

export interface ClaudeThreadBackendOptions {
  adapter: ClaudeCodeAgentRuntimeAdapter;
  store: ClaudeRuntimeSessionStore;
  commands?: readonly UiComposerCommand[] | (() => readonly UiComposerCommand[] | Promise<readonly UiComposerCommand[]>);
  onMessage?(message: UiMessage): void;
  projectName: string;
  branch?: string;
  permissionPolicy?: () => RuntimePermissionPolicy;
}

/**
 * Claude's complete thread owner. It never constructs an AgentSession or
 * consults Pi's SessionManager, model catalog, context window, or extensions.
 */
export class ClaudeThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind = "claude-code" as const;
  readonly runtimeAdapter: ClaudeCodeAgentRuntimeAdapter;
  private record?: Awaited<ReturnType<ClaudeRuntimeSessionStore["get"]>>;
  private messages: UiMessage[] = [];
  private streaming = false;
  private title?: string;
  private titleSource?: ClaudeTitleSource;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    options: ClaudeThreadBackendOptions,
  ) {
    this.runtimeAdapter = options.adapter;
    this.store = options.store;
    this.options = options;
  }

  private readonly store: ClaudeRuntimeSessionStore;
  private readonly options: ClaudeThreadBackendOptions;

  async create(): Promise<void> {
    this.record = await this.store.ensure(this.sessionId, this.cwd);
    this.restoreRecord(this.record);
  }

  async resume(): Promise<void> {
    this.record = await this.store.get(this.sessionId) ?? await this.store.ensure(this.sessionId, this.cwd);
    if (this.record.cwd !== this.cwd) throw new Error("Claude session belongs to another workspace.");
    this.restoreRecord(this.record);
  }

  private restoreRecord(record: NonNullable<ClaudeThreadRuntimeBackend["record"]>): void {
    this.messages = record.messages.map((message, index) => ({
      id: `claude-${message.role}-${message.clientMessageId ?? index}-${message.timestamp}`,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
      ...(message.skill ? { skill: { ...message.skill } } : {}),
    }));
    this.title = record.title;
    this.titleSource = record.titleSource;
  }

  async index(): Promise<UiSession> {
    const firstUser = this.messages.find((message) => message.role === "user");
    return {
      id: this.sessionId,
      path: `tau-claude-session:${this.sessionId}`,
      // The first message is user-controlled and may be an unknown or
      // malformed runtime-looking wrapper. Reuse the same sanitized title
      // path instead of copying its opening tag into the sidebar.
      title: this.title || (firstUser ? derivedClaudeTitle(firstUser.text) : undefined) || "Untitled thread",
      modifiedAt: this.record?.updatedAt ?? Date.now(),
      projectPath: this.cwd,
      projectName: this.options.projectName,
      branch: this.options.branch,
      messageCount: this.messages.length,
      backendKind: this.kind,
    };
  }

  async transcript(): Promise<UiMessage[]> { return this.messages.map((message) => ({ ...message, ...(message.skill ? { skill: { ...message.skill } } : {}) })); }
  async skills(): Promise<UiComposerCommand[]> {
    const commands = this.options.commands;
    if (!commands) return [];
    const value = typeof commands === "function" ? await commands() : commands;
    return value.map((command) => ({ ...command }));
  }

  async catalog(): Promise<ThreadBackendCatalog> {
    return {
      models: [],
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
      composerCommands: await this.skills(),
    };
  }

  async detail(): Promise<ThreadBackendSnapshot> {
    return {
      backendKind: this.kind,
      sessionId: this.sessionId,
      cwd: this.cwd,
      title: this.title,
      titleSource: this.titleSource,
      messages: await this.transcript(),
      isStreaming: this.streaming,
      activeTools: [],
      catalog: await this.catalog(),
    };
  }

  async preparePrompt(text: string, skillName?: string): Promise<PreparedPrompt> {
    assertClaudePermissionPolicySupported(this.options.permissionPolicy?.() ?? runtimePermissionPolicy("full"));
    const commands = await this.skills();
    const effectiveCommands = commands;
    if (skillName && !knownSkillNames(commands).has(canonicalSkillName(skillName))) {
      throw new Error(`The selected skill '${skillName}' is no longer available in this runtime.`);
    }
    const prepared = prepareSkillPrompt(text, this.runtimeAdapter, effectiveCommands);
    return {
      sessionId: this.sessionId,
      backendKind: this.kind,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, [...knownSkillNames(effectiveCommands)]),
    };
  }

  async prompt(input: ThreadBackendPromptInput): Promise<{ assistantText?: string }> {
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Claude delivery.");
    const permissionPolicy = this.options.permissionPolicy?.() ?? runtimePermissionPolicy("full");
    assertClaudePermissionPolicySupported(permissionPolicy);
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    this.assertPreparedPrompt(input.text, prepared, await this.skills());
    if (input.clientMessageId && this.messages.some((message) => message.clientMessageId === input.clientMessageId)) return {};
    if (input.delivery !== "prompt" && this.streaming) throw new Error("Claude Code print mode cannot steer or queue a live turn.");
    // Persist the visible message as soon as the runtime accepts it; the
    // transport separately records the attempt before creating a child.
    const user: UiMessage = {
      id: `claude-user-${input.clientMessageId ?? Date.now()}`,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      role: "user",
      text: prepared.visibleText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      timestamp: Date.now(),
    };
    this.messages.push(user);
    await this.persist([user]);
    this.options.onMessage?.(user);
    if (!this.title) {
      const title = derivedClaudeTitle(prepared.visibleText);
      if (title) {
        this.title = title;
        this.titleSource = "derived";
        await this.store.setTitle(this.sessionId, this.cwd, title, "derived");
      }
    }
    this.streaming = true;
    try {
      const result = await this.runtimeAdapter.transport.sendPrompt({
        cwd: this.cwd,
        sessionId: this.sessionId,
        text: prepared.runtimeText,
        delivery: input.delivery,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        permissionPolicy,
        signal: input.signal,
      });
      if (result.assistantText) {
        const assistant: UiMessage = { id: `claude-assistant-${Date.now()}`, role: "assistant", text: result.assistantText, timestamp: Date.now() };
        this.messages.push(assistant);
        this.options.onMessage?.(assistant);
        await this.persist([assistant]);
      }
      this.record = await this.store.get(this.sessionId);
      return result;
    } finally {
      this.streaming = false;
    }
  }

  async abort(): Promise<void> { await this.runtimeAdapter.transport.abort?.(this.sessionId); this.streaming = false; }
  async persist(messages: readonly UiMessage[]): Promise<void> { await this.store.appendExchange(this.sessionId, this.cwd, messages); }
  async setTitle(title: string, source: ClaudeTitleSource): Promise<void> {
    const safeTitle = derivedClaudeTitle(title) ?? "Skill invocation";
    this.title = safeTitle;
    this.titleSource = source;
    await this.store.setTitle(this.sessionId, this.cwd, safeTitle, source);
  }
  async setModel(): Promise<void> { throw new Error("Claude Code chooses its model in the Claude runtime; Tau model selection is unavailable for this thread."); }
  async setThinkingLevel(): Promise<void> { throw new Error("Claude Code does not expose Pi thinking levels."); }
  async compact(): Promise<void> { throw new Error("Claude Code context compaction is owned by the Claude runtime."); }
  isStreaming(): boolean { return this.streaming; }
  isIdle(): boolean { return !this.streaming; }
  async dispose(): Promise<void> { if (this.streaming) await this.abort(); }

  private assertPreparedPrompt(
    text: string,
    prepared: PreparedPrompt,
    commands: readonly UiComposerCommand[],
  ): void {
    if (prepared.backendKind !== this.kind
      || (prepared.sessionId !== undefined && prepared.sessionId !== this.sessionId)
      || prepared.runtimeCapabilities.skillInvocationDialect !== this.runtimeAdapter.capabilities.skillInvocationDialect) {
      throw new Error("Prepared prompt belongs to another runtime.");
    }
    const names = knownSkillNames(commands);
    if (prepared.skill) {
      const name = canonicalSkillName(prepared.skill.name);
      if (!names.has(name) || prepared.skill.command !== skillInvocationCommand(name, this.runtimeAdapter)
        || prepared.runtimeText !== prepared.skill.copyText) {
        throw new Error("Prepared prompt contains an unavailable skill.");
      }
    } else if (prepared.visibleText !== text || prepared.runtimeText !== text) {
      throw new Error("Prepared prompt no longer matches the message being sent.");
    }
    const expectedFingerprint = clientMessageFingerprint(text, names);
    if (prepared.sourceFingerprint !== expectedFingerprint) {
      throw new Error("Prepared prompt no longer matches the message being sent.");
    }
  }
}
