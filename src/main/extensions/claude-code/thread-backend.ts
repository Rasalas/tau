import type {
  PreparedPrompt,
  UiComposerCommand,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiSession,
  UiSkillDraft,
  UiThreadTree,
} from "../../../shared/contracts.js";
import { clientMessageFingerprint } from "../../../shared/client-message-correlation.js";
import { validatePreparedPrompt } from "../../../shared/prepared-prompt.js";
import { knownSkillNames } from "../../../shared/skill-envelope.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiShortcut, PiUserKeybindings } from "../../../shared/keybindings-protocol.js";
import { prepareSkillPrompt } from "../../skill-invocation.js";
import type { RuntimePermissionLevel } from "../../runtime-adapters.js";
import type { ThreadBackendCatalog, ThreadBackendPromptInput, ThreadBackendSnapshot, ThreadRuntimeBackend, ThreadTitleSource } from "../../thread-runtime-backend.js";
import { assertClaudePermissionPolicySupported, runtimePermissionPolicy, type ClaudeCodeAgentRuntimeAdapter } from "./runtime-adapter.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";

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

export interface ClaudeThreadBackendOptions {
  adapter: ClaudeCodeAgentRuntimeAdapter;
  store: ClaudeRuntimeSessionStore;
  commands?: readonly UiComposerCommand[] | (() => readonly UiComposerCommand[] | Promise<readonly UiComposerCommand[]>);
  onMessage?(message: UiMessage): void;
  projectName: string;
  branch?: string;
  permissionLevel?: () => RuntimePermissionLevel;
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
  private titleSource?: ThreadTitleSource;

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
      projectLabel: this.options.branch,
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
    assertClaudePermissionPolicySupported(runtimePermissionPolicy(this.options.permissionLevel?.() ?? "full"));
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
    const permissionLevel = this.options.permissionLevel?.() ?? "full";
    assertClaudePermissionPolicySupported(runtimePermissionPolicy(permissionLevel));
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
        permissionLevel,
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
  async setTitle(title: string, source: ThreadTitleSource): Promise<void> {
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
  async complete(): Promise<string> {
    throw new Error("Claude Code threads have no model runtime for one-off completions.");
  }
  modelApi(): string | undefined { return undefined; }
  tree(): UiThreadTree { return { sessionId: this.threadId, nodes: [] }; }
  leafEntryId(): string | undefined { return undefined; }
  async navigateTree(): Promise<{ cancelled: boolean }> { throw new Error("Claude Code threads have no session tree to move in."); }
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
