import type {
  PreparedPrompt,
  RuntimeCapabilities,
  ThreadBackendKind,
  UiComposerCommand,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiSession,
  UiSkillDraft,
  UiSkillInvocation,
  UiToolRun,
} from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { prepareSkillPrompt, skillInvocationCommand } from "./skill-invocation.js";
import { assertClaudePermissionPolicySupported, runtimePermissionPolicy, type AgentRuntimeAdapter, type ClaudeCodeAgentRuntimeAdapter, type RuntimePermissionPolicy } from "./runtime-adapters.js";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
import { ClaudeRuntimeSessionStore, type ClaudeTitleSource } from "./claude-runtime-store.js";

export interface ThreadBackendPromptInput {
  text: string;
  delivery: "prompt" | "steer" | "followUp";
  clientMessageId?: string;
  prepared?: PreparedPrompt;
  signal?: AbortSignal;
  /** SDK-specific prompt options stay inside the Pi backend boundary. */
  promptOptions?: Parameters<AgentSession["prompt"]>[1];
  images?: Parameters<AgentSession["steer"]>[1];
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
  /** Tau's stable thread id. Provider session ids never cross this boundary. */
  threadId: string;
  /** Provider/runtime session id, when the backend has one. */
  providerSessionId: string;
  /** Compatibility field for the v1 wire contract. */
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
  /** Tau's stable thread id. */
  readonly threadId: string;
  /** Runtime-owned provider session id. */
  readonly providerSessionId: string;
  /** @deprecated Use threadId. Kept only for v1 IPC callers. */
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
  /** Synchronous command projection for event/correlation paths. */
  composerCommands(): UiComposerCommand[];
  preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt>;
  prompt(input: ThreadBackendPromptInput): Promise<{ assistantText?: string }>;
  abort(): Promise<void>;
  persist(messages: readonly UiMessage[]): Promise<void>;
  setTitle(title: string, source: ClaudeTitleSource): Promise<void>;
  setModel(provider: string, id: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  compact(): Promise<void>;
  /** Backend-owned session operations used by the host's event/persistence seam. */
  sessionFile(): string | undefined;
  sessionName(): string | undefined;
  branchEntries(): readonly unknown[];
  hasMessages(): boolean;
  appendCustomEntry(customType: string, data?: unknown): void;
  appendMessage(message: unknown): void;
  bind(
    bindings: Parameters<AgentSession["bindExtensions"]>[0],
    listener: Parameters<AgentSession["subscribe"]>[0],
  ): Promise<void>;
  unbind(): void;
  setLifecycleHooks(beforeInvalidate: () => void, rebind: () => Promise<void>): void;
  reload(): Promise<void>;
  extensionCount(): number;
  isBashRunning(): boolean;
  executeBash(command: string, includeInContext: boolean): Promise<Awaited<ReturnType<AgentSession["executeBash"]>>>;
  createFork(entryId: string): string | undefined;
  waitForIdle(): Promise<void>;
  completeTitle(provider: string, modelId: string, conversation: string): Promise<string>;
  modelApi(): string | undefined;
  /** Shortcuts the runtime's extensions registered; Pi resolves them against the user's keybindings.json. */
  shortcuts(userBindings: PiUserKeybindings): PiShortcut[];
  runShortcut(keys: string, userBindings: PiUserKeybindings): Promise<boolean>;
  model(): UiModel | undefined;
  thinkingLevel(): string;
  thinkingLevels(): string[];
  activeToolNames(): string[];
  allTools(): Array<{ name: string; description: string }>;
  contextUsage(): UiContextUsage | undefined;
  isStreaming(): boolean;
  isIdle(): boolean;
  dispose(): Promise<void>;
}

export interface PiThreadBackendOptions {
  mapMessages(messages: readonly unknown[]): UiMessage[];
  index(backend: PiThreadRuntimeBackend): Promise<UiSession>;
}

function modelOf(model: { provider: string; id: string; name?: string } | undefined): UiModel | undefined {
  return model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : undefined;
}

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

  /** The SDK session is deliberately private to this backend implementation. */
  private get session(): AgentSession { return this.runtime.session; }
  get threadId(): string { return this.runtime.session.sessionId; }
  get providerSessionId(): string { return this.runtime.session.sessionId; }
  /** @deprecated Use threadId. */
  get sessionId(): string { return this.threadId; }
  get cwd(): string { return this.runtime.cwd; }

  async create(): Promise<void> {
    if (this.lifecycle === "disposed") throw new Error("The Pi runtime backend has been disposed.");
    if (this.lifecycle === "new") this.lifecycle = "created";
  }
  async resume(): Promise<void> {
    if (this.lifecycle === "disposed") throw new Error("The Pi runtime backend has been disposed.");
    if (this.lifecycle === "new") this.lifecycle = "resumed";
  }
  async index(): Promise<UiSession> { return this.options.index(this); }
  async transcript(): Promise<UiMessage[]> { return this.options.mapMessages(this.session.messages); }
  private resourceCommands(): UiComposerCommand[] {
    const loader = this.session.resourceLoader;
    const commands = new Map<string, UiComposerCommand>();
    for (const extension of loader.getExtensions().extensions) {
      if (extension.hidden) continue;
      for (const command of extension.commands.values()) {
        if (command.name.startsWith("tau-bridge-")) continue;
        commands.set(command.name, { name: command.name, description: command.description, source: "extension" });
      }
    }
    for (const prompt of loader.getPrompts().prompts) {
      if (commands.has(prompt.name)) continue;
      commands.set(prompt.name, { name: prompt.name, description: prompt.description, argumentHint: prompt.argumentHint, source: "prompt" });
    }
    if (this.session.settingsManager.getEnableSkillCommands()) {
      for (const skill of loader.getSkills().skills) {
        commands.set(`skill:${skill.name}`, {
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          skillCommand: skillInvocationCommand(skill.name, this.runtimeAdapter),
        });
      }
    }
    return [...commands.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
  composerCommands(): UiComposerCommand[] { return this.resourceCommands(); }
  async skills(): Promise<UiComposerCommand[]> { return this.resourceCommands(); }

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
      threadId: this.threadId,
      providerSessionId: this.providerSessionId,
      sessionId: this.threadId,
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

  async preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
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

  async prompt(input: ThreadBackendPromptInput): Promise<{ assistantText?: string }> {
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    validatePreparedPrompt(input.text, prepared, {
      backendKind: this.kind,
      threadId: this.threadId,
      providerSessionId: this.providerSessionId,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      commands: await this.skills(),
    });
    if (input.delivery === "steer") await this.session.steer(prepared.runtimeText, input.images);
    else if (input.delivery === "followUp") await this.session.followUp(prepared.runtimeText, input.images);
    else await this.session.prompt(prepared.runtimeText, input.promptOptions);
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
  async setTitle(title: string, _source: ClaudeTitleSource): Promise<void> { this.session.setSessionName(title); }
  async setModel(provider: string, id: string): Promise<void> {
    const model = this.session.modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
    await this.session.setModel(model);
  }
  async setThinkingLevel(level: string): Promise<void> { this.session.setThinkingLevel(level as never); }
  async compact(): Promise<void> { await this.session.compact(); }
  sessionFile(): string | undefined { return this.session.sessionFile ?? this.session.sessionManager.getSessionFile(); }
  sessionName(): string | undefined { return this.session.sessionName; }
  branchEntries(): readonly unknown[] { return this.session.sessionManager.getBranch(); }
  hasMessages(): boolean { return this.session.messages.length > 0; }
  appendCustomEntry(customType: string, data?: unknown): void { this.session.sessionManager.appendCustomEntry(customType, data); }
  appendMessage(message: unknown): void { this.session.sessionManager.appendMessage(message as Parameters<AgentSession["sessionManager"]["appendMessage"]>[0]); }
  async bind(
    bindings: Parameters<AgentSession["bindExtensions"]>[0],
    listener: Parameters<AgentSession["subscribe"]>[0],
  ): Promise<void> {
    await this.session.bindExtensions(bindings);
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe(listener);
  }
  unbind(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  private unsubscribe?: () => void;
  setLifecycleHooks(beforeInvalidate: () => void, rebind: () => Promise<void>): void {
    this.runtime.setBeforeSessionInvalidate(beforeInvalidate);
    this.runtime.setRebindSession(async () => { await rebind(); });
  }
  async reload(): Promise<void> { await this.session.reload(); }
  extensionCount(): number { return this.session.resourceLoader.getExtensions().extensions.length; }
  isBashRunning(): boolean { return this.session.isBashRunning; }
  async executeBash(command: string, includeInContext: boolean): Promise<Awaited<ReturnType<AgentSession["executeBash"]>>> {
    return this.session.executeBash(command, undefined, { excludeFromContext: !includeInContext });
  }
  createFork(entryId: string): string | undefined { return this.session.sessionManager.createBranchedSession(entryId); }
  waitForIdle(): Promise<void> { return this.session.waitForIdle(); }
  async completeTitle(provider: string, modelId: string, conversation: string): Promise<string> {
    const model = this.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown title model: ${provider}/${modelId}`);
    const response = await this.session.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: "Create a concise coding-thread title as one plain-text noun phrase. Use 3-7 words and at most 60 characters. Name the concrete task, change, or decision. Never use Markdown, quotes, terminal punctuation, a label, a complete sentence, or meta wording such as working on, help with, discussion about, or implementing.",
        messages: [{
          role: "user",
          content: [{ type: "text", text: `Return only the plain-text title for this thread. Match the conversation's language.\n\n${conversation}` }],
          timestamp: Date.now(),
        }],
      },
      { maxTokens: 48, cacheRetention: "none", timeoutMs: 30_000 },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "The title model did not complete.");
    }
    const content = response.content;
    return Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "").join("")
      : String(content ?? "");
  }
  modelApi(): string | undefined { return (this.session.model as { api?: string } | undefined)?.api; }
  private shortcutMap(userBindings: PiUserKeybindings) {
    type Config = Parameters<AgentSession["extensionRunner"]["getShortcuts"]>[0];
    return this.session.extensionRunner.getShortcuts(userBindings as Config);
  }
  shortcuts(userBindings: PiUserKeybindings): PiShortcut[] {
    return [...this.shortcutMap(userBindings).entries()].map(([keys, shortcut]) => ({
      keys: keys.toLowerCase(),
      ...(shortcut.description ? { description: shortcut.description } : {}),
      source: basename(shortcut.extensionPath),
    }));
  }
  async runShortcut(keys: string, userBindings: PiUserKeybindings): Promise<boolean> {
    const shortcut = this.shortcutMap(userBindings).get(keys.toLowerCase() as never);
    if (!shortcut) return false;
    await shortcut.handler(this.session.extensionRunner.createContext());
    return true;
  }
  model(): UiModel | undefined { return modelOf(this.session.model); }
  thinkingLevel(): string { return this.session.thinkingLevel; }
  thinkingLevels(): string[] { return this.session.getAvailableThinkingLevels(); }
  activeToolNames(): string[] { return this.session.getActiveToolNames(); }
  allTools(): Array<{ name: string; description: string }> {
    return this.session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description }));
  }
  contextUsage(): UiContextUsage | undefined {
    const usage = this.session.getContextUsage();
    return usage && usage.tokens !== null && usage.percent !== null
      ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
      : undefined;
  }
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
    readonly threadId: string,
    readonly cwd: string,
    options: ClaudeThreadBackendOptions,
  ) {
    this.runtimeAdapter = options.adapter;
    this.store = options.store;
    this.options = options;
  }

  private readonly store: ClaudeRuntimeSessionStore;
  private readonly options: ClaudeThreadBackendOptions;

  /** @deprecated Use threadId. */
  get sessionId(): string { return this.threadId; }
  get providerSessionId(): string {
    return this.record?.claudeSessionId ?? this.threadId;
  }

 async create(): Promise<void> {
   this.record = await this.store.ensure(this.threadId, this.cwd);
   this.restoreRecord(this.record);
 }

 async resume(): Promise<void> {
   this.record = await this.store.get(this.threadId) ?? await this.store.ensure(this.threadId, this.cwd);
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
      id: this.threadId,
      path: `tau-claude-session:${this.threadId}`,
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
  composerCommands(): UiComposerCommand[] {
    const commands = this.options.commands;
    if (!commands || typeof commands === "function") return [];
    return commands.map((command) => ({ ...command }));
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
      threadId: this.threadId,
      providerSessionId: this.providerSessionId,
      sessionId: this.threadId,
      cwd: this.cwd,
      title: this.title,
      titleSource: this.titleSource,
      messages: await this.transcript(),
      isStreaming: this.streaming,
      activeTools: [],
      catalog: await this.catalog(),
    };
  }

  async preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
    assertClaudePermissionPolicySupported(this.options.permissionPolicy?.() ?? runtimePermissionPolicy("full"));
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

  async prompt(input: ThreadBackendPromptInput): Promise<{ assistantText?: string }> {
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Claude delivery.");
    const permissionPolicy = this.options.permissionPolicy?.() ?? runtimePermissionPolicy("full");
    assertClaudePermissionPolicySupported(permissionPolicy);
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    this.assertPreparedPrompt(input.text, prepared, await this.skills());
    if (input.clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === input.clientMessageId);
      if (existing) {
        const sameSkill = JSON.stringify(existing.skill ?? null) === JSON.stringify(prepared.skill ?? null);
        if (existing.text === prepared.visibleText && sameSkill) return {};
        throw new Error(`Claude transcript already contains a conflicting message id '${input.clientMessageId}'.`);
      }
    }
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
        await this.store.setTitle(this.threadId, this.cwd, title, "derived");
      }
    }
    this.streaming = true;
    try {
      const result = await this.runtimeAdapter.transport.sendPrompt({
        cwd: this.cwd,
        tauThreadId: this.threadId,
        sessionId: this.providerSessionId,
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
      this.record = await this.store.get(this.threadId);
      return result;
    } finally {
      this.streaming = false;
    }
  }

 async abort(): Promise<void> { await this.runtimeAdapter.transport.abort?.(this.threadId); this.streaming = false; }
  async persist(messages: readonly UiMessage[]): Promise<void> {
    const commands = await this.skills();
    await this.store.appendExchange(this.threadId, this.cwd, messages, {
      knownSkillNames: knownSkillNames(commands),
    });
  }
  async setTitle(title: string, source: ClaudeTitleSource): Promise<void> {
    const safeTitle = derivedClaudeTitle(title) ?? "Skill invocation";
    this.title = safeTitle;
    this.titleSource = source;
    await this.store.setTitle(this.threadId, this.cwd, safeTitle, source);
  }
  async setModel(): Promise<void> { throw new Error("Claude Code chooses its model in the Claude runtime; Tau model selection is unavailable for this thread."); }
  async setThinkingLevel(): Promise<void> { throw new Error("Claude Code does not expose Pi thinking levels."); }
  async compact(): Promise<void> { throw new Error("Claude Code context compaction is owned by the Claude runtime."); }
  sessionFile(): string | undefined { return undefined; }
  sessionName(): string | undefined { return this.title; }
  branchEntries(): readonly unknown[] {
    return this.messages.map((message) => ({ type: "message", id: message.id, message }));
  }
  hasMessages(): boolean { return this.messages.length > 0; }
  appendCustomEntry(): void { throw new Error("Claude Code does not expose Pi custom entries."); }
  appendMessage(): void { throw new Error("Claude Code owns transcript persistence through its backend store."); }
  async bind(): Promise<void> { /* Claude has no Pi extension carrier. */ }
  unbind(): void { /* Claude has no Pi extension carrier. */ }
  setLifecycleHooks(): void { /* Claude transport owns its own lifecycle. */ }
  async reload(): Promise<void> { await this.resume(); }
  extensionCount(): number { return 0; }
  isBashRunning(): boolean { return false; }
  async executeBash(): Promise<Awaited<ReturnType<AgentSession["executeBash"]>>> {
    throw new Error("Project actions are unavailable for Claude Code threads.");
  }
  createFork(): string | undefined { throw new Error("Claude Code threads cannot be forked by the Pi session manager."); }
  async waitForIdle(): Promise<void> {
    if (!this.streaming) return;
    await new Promise<void>((resolve) => {
      const check = () => this.streaming ? setTimeout(check, 10).unref?.() : resolve();
      check();
    });
  }
  async completeTitle(): Promise<string> {
    throw new Error("Claude Code title generation is owned by the Claude runtime.");
  }
  modelApi(): string | undefined { return undefined; }
  shortcuts(): PiShortcut[] { return []; }
  async runShortcut(): Promise<boolean> { return false; }
  model(): UiModel | undefined { return undefined; }
  thinkingLevel(): string { return "off"; }
  thinkingLevels(): string[] { return ["off"]; }
  activeToolNames(): string[] { return []; }
  allTools(): Array<{ name: string; description: string }> { return []; }
  contextUsage(): UiContextUsage | undefined { return undefined; }
  isStreaming(): boolean { return this.streaming; }
  isIdle(): boolean { return !this.streaming; }
 async dispose(): Promise<void> { if (this.streaming) await this.abort(); }

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
