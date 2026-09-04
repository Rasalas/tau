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
  UiThreadTree,
  UiThreadTreeNode,
} from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { prepareSkillPrompt, skillInvocationCommand } from "./skill-invocation.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";

/** Where a thread's title came from; a derived title may be replaced by a generated one. */
export type ThreadTitleSource = "derived" | "generated" | "renamed";

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
  titleSource?: ThreadTitleSource;
  messages: UiMessage[];
  isStreaming: boolean;
  activeTools: string[];
  model?: UiModel;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  catalog: ThreadBackendCatalog;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
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
  setTitle(title: string, source: ThreadTitleSource): Promise<void>;
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
  /** The session tree and the entry the thread continues from. */
  tree(): UiThreadTree;
  leafEntryId(): string | undefined;
  navigateTree(entryId: string, options: { summarize?: boolean }): Promise<{ cancelled: boolean; draftText?: string }>;
  waitForIdle(): Promise<void>;
  completeTitle(provider: string, modelId: string, conversation: string): Promise<string>;
  /** One short answer from a model of this runtime, outside the thread's conversation. */
  complete(provider: string, modelId: string, request: CompletionRequest): Promise<string>;
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

interface SessionTreeEntry {
  type: string;
  id: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  summary?: string;
}

function entryText(content: unknown): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []).join("\n")
      : "";
  return text.trim().split("\n")[0]?.slice(0, 160) ?? "";
}

/** The entries Pi's tree selector shows: messages and summaries; everything else is structure only. */
function treeNodeOf(entry: SessionTreeEntry, label: string | undefined): Omit<UiThreadTreeNode, "parentId" | "depth" | "onBranch" | "isLeaf"> | undefined {
  const timestamp = entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0;
  if (entry.type === "message" && entry.message) {
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") return undefined;
    const text = entryText(entry.message.content);
    if (!text && role === "assistant") return undefined;
    return { id: entry.id, kind: role, text: text || "(image)", ...(label ? { label } : {}), timestamp, forkable: role === "user" };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { id: entry.id, kind: "summary", text: entryText(entry.summary), ...(label ? { label } : {}), timestamp, forkable: false };
  }
  return undefined;
}

function modelOf(model: { provider: string; id: string; name?: string } | undefined): UiModel | undefined {
  return model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : undefined;
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
  async setTitle(title: string, _source: ThreadTitleSource): Promise<void> { this.session.setSessionName(title); }
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
  completeTitle(provider: string, modelId: string, conversation: string): Promise<string> {
    return this.complete(provider, modelId, {
      system: "Create a concise coding-thread title as one plain-text noun phrase. Use 3-7 words and at most 60 characters. Name the concrete task, change, or decision. Never use Markdown, quotes, terminal punctuation, a label, a complete sentence, or meta wording such as working on, help with, discussion about, or implementing.",
      prompt: `Return only the plain-text title for this thread. Match the conversation's language.\n\n${conversation}`,
      maxTokens: 48,
    });
  }
  async complete(provider: string, modelId: string, request: CompletionRequest): Promise<string> {
    const model = this.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    const response = await this.session.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: request.system,
        messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
      },
      { maxTokens: request.maxTokens ?? 48, cacheRetention: "none", timeoutMs: 30_000 },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "The model did not complete.");
    }
    const content = response.content;
    return Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "").join("")
      : String(content ?? "");
  }
  tree(): UiThreadTree {
    const manager = this.session.sessionManager;
    const branch = (manager.getBranch() as Array<{ id?: string }>).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
    const onBranch = new Set(branch);
    const nodes: UiThreadTreeNode[] = [];
    const walk = (children: ReturnType<typeof manager.getTree>, depth: number, parentId: string | undefined) => {
      for (const node of children) {
        const shown = treeNodeOf(node.entry as SessionTreeEntry, node.label);
        if (shown) {
          nodes.push({ ...shown, parentId, depth, onBranch: onBranch.has(shown.id), isLeaf: false });
          walk(node.children, depth + 1, shown.id);
        } else {
          // Model or thinking changes and labels stay invisible; their children hang off the last shown ancestor.
          walk(node.children, depth, parentId);
        }
      }
    };
    walk(manager.getTree(), 0, undefined);
    // The raw leaf is often a hidden entry (a marker, a label); the thread "is at" the last shown entry of its branch.
    const shownIds = new Set(nodes.map((node) => node.id));
    const leafId = [...branch].reverse().find((id) => shownIds.has(id)) ?? manager.getLeafId() ?? undefined;
    for (const node of nodes) node.isLeaf = node.id === leafId;
    return { sessionId: this.threadId, leafId, nodes };
  }
  leafEntryId(): string | undefined { return this.session.sessionManager.getLeafId() ?? undefined; }
  async navigateTree(entryId: string, options: { summarize?: boolean }): Promise<{ cancelled: boolean; draftText?: string }> {
    const result = await this.session.navigateTree(entryId, { summarize: options.summarize ?? false });
    return { cancelled: result.cancelled, ...(result.editorText ? { draftText: result.editorText } : {}) };
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

