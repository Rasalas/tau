import type {
  PreparedPrompt,
  UiComposerCommand,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiSkillDraft,
  UiThreadTree,
  UiThreadTreeNode,
  UiThreadUsage,
  SystemPromptInspection,
} from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { isOfferedMode, threadModeFromEntries, THREAD_MODE_ENTRY } from "../shared/thread-mode.js";
import { prepareSkillPrompt, skillInvocationCommand } from "./skill-invocation.js";
import { createExtensionUiContext } from "./extension-ui.js";
import { promptImages } from "./prompt-attachments.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
import type {
  CompletionRequest,
  RuntimeEventListener,
  RuntimeExtensionBindings,
  ShellCommandResult,
  ThreadBackendCapabilities,
  ThreadBackendPromptInput,
  ThreadBackendPromptResult,
  ThreadBackendState,
  ThreadCatalogView,
  ThreadRuntimeBackend,
  ThreadTitleSource,
} from "./runtime-types.js";

/** Marks a row Tau wrote into a thread itself; the transcript draws it as a notice. */
const TAU_NOTICE_ENTRY = "tau_notice";

export interface PiThreadBackendOptions {
  mapMessages(messages: readonly unknown[]): UiMessage[];
  /** The interaction modes runtime extensions give Pi threads (`RuntimeExtensionOptions.modes`). */
  modes?(): readonly string[];
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

import { modelAttribution } from "./model-attribution.js";
import { modelLogin, type ProviderLoginSource } from "./model-login.js";

function modelOf(model: { provider: string; id: string; name?: string } | undefined, runtime?: ProviderLoginSource): UiModel | undefined {
  if (!model) return undefined;
  const login = modelLogin(runtime, model.provider);
  return { provider: model.provider, id: model.id, name: model.name ?? model.id, ...(login ? { login } : {}) };
}

/** Deep adapter around the Pi SDK. It keeps Pi transcript/context state in Pi. */
export class PiThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind = "pi" as const;
  readonly runtimeAdapter: AgentRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities;
  private lifecycle: "new" | "created" | "resumed" | "disposed" = "new";
  private unsubscribe?: () => void;

  constructor(
    private readonly runtime: AgentSessionRuntime,
    adapter: AgentRuntimeAdapter,
    private readonly options: PiThreadBackendOptions,
  ) {
    if (adapter.id !== "pi") throw new Error("Pi backend requires the Pi runtime adapter.");
    this.runtimeAdapter = adapter;
    this.capabilities = {
      journal: {
        entries: () => this.session.sessionManager.getBranch(),
        appendCustomEntry: (customType, data) => { this.session.sessionManager.appendCustomEntry(customType, data); },
        appendMessage: (message) => {
          this.session.sessionManager.appendMessage(message as Parameters<AgentSession["sessionManager"]["appendMessage"]>[0]);
        },
      },
      tree: {
        tree: () => this.tree(),
        leafEntryId: () => this.session.sessionManager.getLeafId() ?? undefined,
        navigateTree: (entryId, navigateOptions) => this.navigateTree(entryId, navigateOptions),
      },
      // Pi's fork is a new session file the host opens itself.
      fork: { runtimeOwned: false },
      shellAction: {
        isRunning: () => this.session.isBashRunning,
        run: (command, includeInContext) => this.runShellCommand(command, includeInContext),
      },
      compaction: { compact: async () => { await this.session.compact(); } },
      catalogWrite: {
        setModel: (provider, id) => this.setModel(provider, id),
        setThinkingLevel: async (level) => { this.session.setThinkingLevel(level as never); },
      },
      completions: {
        complete: (provider, modelId, request) => this.complete(provider, modelId, request),
        modelApi: () => (this.session.model as { api?: string } | undefined)?.api,
      },
      extensions: {
        bind: (bindings) => this.bind(bindings),
        unbind: () => { this.unsubscribe?.(); this.unsubscribe = undefined; },
        setLifecycleHooks: (beforeInvalidate, rebind) => {
          this.runtime.setBeforeSessionInvalidate(beforeInvalidate);
          this.runtime.setRebindSession(async () => { await rebind(); });
        },
        shortcuts: (userBindings) => this.shortcuts(userBindings),
        runShortcut: (keys, userBindings) => this.runShortcut(keys, userBindings),
      },
      reload: { reload: () => this.session.reload() },
      resume: {
        hiddenPrompt: true,
        notice: (text) => this.appendNotice(text),
      },
      events: { subscribe: (listener) => this.subscribe(listener) },
      systemPrompt: { inspect: () => this.inspectSystemPrompt() },
      mode: {
        modes: () => this.options.modes?.() ?? [],
        current: () => this.mode ??= threadModeFromEntries(this.session.sessionManager.getBranch()),
        set: (mode) => this.setMode(mode),
      },
    };
  }

  /** Read from the journal once; the branch only moves through `navigateTree`, which drops it. */
  private mode: string | undefined;

  private async setMode(mode: string): Promise<void> {
    if (!isOfferedMode(mode, this.options.modes?.())) throw new Error(`This thread offers no "${mode}" mode.`);
    if (this.capabilities.mode!.current() === mode) return;
    this.session.sessionManager.appendCustomEntry(THREAD_MODE_ENTRY, { mode });
    this.mode = mode;
  }

  /** The SDK session is deliberately private to this backend implementation. */
  private get session(): AgentSession { return this.runtime.session; }
  get threadId(): string { return this.runtime.session.sessionId; }
  get providerSessionId(): string { return this.runtime.session.sessionId; }
  get cwd(): string { return this.runtime.cwd; }

  async start(mode: "create" | "resume"): Promise<void> {
    if (this.lifecycle === "disposed") throw new Error("The Pi runtime backend has been disposed.");
    if (this.lifecycle === "new") this.lifecycle = mode === "resume" ? "resumed" : "created";
  }

  state(): ThreadBackendState {
    const sessionFile = this.session.sessionFile ?? this.session.sessionManager.getSessionFile();
    return {
      streaming: this.session.isStreaming,
      idle: this.session.isIdle,
      hasMessages: this.session.messages.length > 0,
      title: this.session.sessionName,
      ...(sessionFile ? { sessionFile } : {}),
      activeTools: this.session.getActiveToolNames(),
      supportsImageInput: (this.session.model as { input?: readonly string[] } | undefined)?.input?.includes("image") === true,
      extensionCount: this.session.resourceLoader.getExtensions().extensions.length,
    };
  }

  catalogView(): ThreadCatalogView {
    const backend = this;
    return {
      model: modelOf(this.session.model, this.session.modelRuntime),
      thinkingLevel: this.session.thinkingLevel,
      thinkingLevels: this.session.getAvailableThinkingLevels(),
      allTools: this.session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
      // Both walk the whole session; a catalog that does not show them must not pay for them.
      get contextUsage() { return backend.contextUsage(); },
      get usage() { return backend.threadUsage(); },
    };
  }

  async models(): Promise<UiModel[]> {
    return (await this.session.modelRuntime.getAvailable()).map((model) => modelOf(model, this.session.modelRuntime)!);
  }

  async transcript(): Promise<UiMessage[]> { return this.options.mapMessages(this.session.messages); }

  private inspectSystemPrompt(): SystemPromptInspection {
    const loader = this.session.resourceLoader;
    const basePrompt = loader.getSystemPrompt();
    const basePromptSource = loader.getSystemPromptSource()?.path;
    const appendTexts = loader.getAppendSystemPrompt();
    const appendSources = loader.getAppendSystemPromptSources();
    const appends = appendTexts.map((text, index) => ({
      text,
      source: appendSources[index]?.path,
    }));
    const contextFiles = loader.getAgentsFiles().agentsFiles;
    return {
      effectivePrompt: this.session.systemPrompt,
      ...(basePrompt ? { basePrompt } : {}),
      ...(basePromptSource ? { basePromptSource } : {}),
      appends,
      contextFiles,
    };
  }

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

  async preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
    const effectiveCommands = this.composerCommands();
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
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    validatePreparedPrompt(input.text, prepared, {
      backendKind: this.kind,
      threadId: this.threadId,
      providerSessionId: this.providerSessionId,
      runtimeCapabilities: this.runtimeAdapter.capabilities,
      commands: this.composerCommands(),
    });
    // Pi's own prompt options are assembled here and nowhere else.
    const images = input.attachments?.length ? promptImages(input.attachments) : undefined;
    if (input.delivery === "steer") await this.session.steer(prepared.runtimeText, images);
    else if (input.delivery === "followUp") await this.session.followUp(prepared.runtimeText, images);
    else if (input.hidden) {
      // A continuation the host wrote, not the user: Pi's custom message is a
      // notice in the transcript and an ordinary user turn to the model.
      await this.session.sendCustomMessage(
        { customType: TAU_NOTICE_ENTRY, content: [{ type: "text", text: prepared.runtimeText }], display: true },
        { triggerTurn: true },
      );
      input.onAdmitted?.(true);
    } else {
      await this.session.prompt(prepared.runtimeText, {
        images,
        streamingBehavior: input.queued ? "followUp" : undefined,
        ...(input.onAdmitted ? { preflightResult: (success: boolean) => input.onAdmitted?.(success) } : {}),
      });
    }
    return {};
  }

  async abort(): Promise<void> { await this.session.abort(); }

  /**
   * A durable transcript row that belongs to nobody. It goes in as a message
   * entry rather than through `sendCustomMessage`: the transcript projection
   * walks message entries, and a custom-message entry would never be drawn.
   */
  private async appendNotice(text: string): Promise<void> {
    this.session.sessionManager.appendMessage({
      role: "custom",
      customType: TAU_NOTICE_ENTRY,
      content: [{ type: "text", text }],
      display: true,
      timestamp: Date.now(),
    } as Parameters<AgentSession["sessionManager"]["appendMessage"]>[0]);
  }

  async persist(messages: readonly UiMessage[]): Promise<void> {
    if (this.lifecycle === "disposed") throw new Error("The Pi runtime backend has been disposed.");
    if (this.lifecycle === "new") await this.start("resume");
    // SessionManager is Pi's durable writer. Reading its active branch here
    // gives callers an explicit completion point without duplicating entries
    // or attempting to serialize Pi's private message format in Tau.
    if (messages.length > 0 && !Array.isArray(this.session.sessionManager.getBranch())) {
      throw new Error("Pi did not expose a durable session branch.");
    }
  }

  async setTitle(title: string, _source: ThreadTitleSource): Promise<void> { this.session.setSessionName(title); }

  private async setModel(provider: string, id: string): Promise<void> {
    const model = this.session.modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
    await this.session.setModel(model);
  }

  private async bind(bindings: RuntimeExtensionBindings): Promise<void> {
    await this.session.bindExtensions({
      uiContext: createExtensionUiContext(bindings.ui),
      mode: "rpc",
      onError: bindings.onError,
    });
  }

  private subscribe(listener: RuntimeEventListener): () => void {
    this.unsubscribe?.();
    const stop = this.session.subscribe((event) => listener(event, this.threadId));
    this.unsubscribe = stop;
    return () => { if (this.unsubscribe === stop) this.unsubscribe = undefined; stop(); };
  }

  private async runShellCommand(command: string, includeInContext: boolean): Promise<ShellCommandResult> {
    const result = await this.session.executeBash(command, undefined, { excludeFromContext: !includeInContext });
    return {
      output: result.output,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      cancelled: result.cancelled,
      truncated: result.truncated,
    };
  }

  waitForIdle(): Promise<void> { return this.session.waitForIdle(); }

  private async complete(provider: string, modelId: string, request: CompletionRequest): Promise<string> {
    const model = this.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    const attribution = modelAttribution(model, this.threadId);
    const response = await this.session.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: request.system,
        messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
      },
      {
        maxTokens: request.maxTokens ?? 48,
        cacheRetention: "none",
        timeoutMs: 30_000,
        sessionId: attribution.sessionId,
        ...(attribution.headers ? { headers: attribution.headers } : {}),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "The model did not complete.");
    }
    const content = response.content;
    return Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "").join("")
      : String(content ?? "");
  }

  private tree(): UiThreadTree {
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

  private async navigateTree(entryId: string, options: { summarize?: boolean }): Promise<{ cancelled: boolean; draftText?: string }> {
    const result = await this.session.navigateTree(entryId, { summarize: options.summarize ?? false });
    this.mode = undefined;
    return { cancelled: result.cancelled, ...(result.editorText ? { draftText: result.editorText } : {}) };
  }

  private shortcutMap(userBindings: PiUserKeybindings) {
    type Config = Parameters<AgentSession["extensionRunner"]["getShortcuts"]>[0];
    return this.session.extensionRunner.getShortcuts(userBindings as Config);
  }

  private shortcuts(userBindings: PiUserKeybindings): PiShortcut[] {
    return [...this.shortcutMap(userBindings).entries()].map(([keys, shortcut]) => ({
      keys: keys.toLowerCase(),
      ...(shortcut.description ? { description: shortcut.description } : {}),
      source: basename(shortcut.extensionPath),
    }));
  }

  private async runShortcut(keys: string, userBindings: PiUserKeybindings): Promise<boolean> {
    const shortcut = this.shortcutMap(userBindings).get(keys.toLowerCase() as never);
    if (!shortcut) return false;
    await shortcut.handler(this.session.extensionRunner.createContext());
    return true;
  }

  /** What the thread has cost so far, straight from Pi's own session totals. */
  private threadUsage(): UiThreadUsage | undefined {
    const stats = this.session.getSessionStats();
    if (stats.assistantMessages === 0 && stats.tokens.total === 0) return undefined;
    return {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      totalTokens: stats.tokens.total,
      costUsd: stats.cost,
      turns: stats.assistantMessages,
    };
  }

  private contextUsage(): UiContextUsage | undefined {
    const usage = this.session.getContextUsage();
    return usage && usage.tokens !== null && usage.percent !== null
      ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
      : undefined;
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === "disposed") return;
    this.lifecycle = "disposed";
    await this.runtime.dispose();
  }
}
