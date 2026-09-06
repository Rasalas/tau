import {
  clientMessageFingerprint,
  knownSkillNames,
  prepareSkillPrompt,
  validatePreparedPrompt,
  type PreparedPrompt,
  type RuntimePermissionLevel,
  type ThreadBackendCapabilities,
  type ThreadBackendPromptInput,
  type ThreadBackendPromptResult,
  type ThreadBackendState,
  type ThreadCatalogView,
  type ThreadRuntimeBackend,
  type ThreadTitleSource,
  type UiComposerCommand,
  type UiMessage,
  type UiModel,
  type UiSkillDraft,
} from "tau/host-extension";
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
  /** Print mode owns its turn: nothing streams, and no Pi-shaped operation exists. */
  readonly turnReporting = "awaited" as const;
  readonly capabilities: ThreadBackendCapabilities = {};
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

  async start(mode: "create" | "resume"): Promise<void> {
    if (mode === "create") {
      this.record = await this.store.ensure(this.threadId, this.cwd);
    } else {
      this.record = await this.store.get(this.threadId) ?? await this.store.ensure(this.threadId, this.cwd);
      if (this.record.cwd !== this.cwd) throw new Error("Claude session belongs to another workspace.");
    }
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

  state(): ThreadBackendState {
    return {
      streaming: this.streaming,
      idle: !this.streaming,
      hasMessages: this.messages.length > 0,
      ...(this.title ? { title: this.title } : {}),
      ...(this.titleSource ? { titleSource: this.titleSource } : {}),
      activeTools: [],
      supportsImageInput: false,
      extensionCount: 0,
    };
  }

  catalogView(): ThreadCatalogView {
    return { thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] };
  }

  async models(): Promise<UiModel[]> { return []; }

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

  async prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult> {
    if (input.delivery !== "prompt" && input.delivery !== "steer" && input.delivery !== "followUp") throw new Error("Unsupported Claude delivery.");
    const permissionLevel = this.options.permissionLevel?.() ?? "full";
    assertClaudePermissionPolicySupported(runtimePermissionPolicy(permissionLevel));
    const prepared = input.prepared ?? await this.preparePrompt(input.text);
    this.assertPreparedPrompt(input.text, prepared, await this.skills());
    const clientMessageId = input.identity?.clientMessageId;
    if (input.attachments?.length) throw new Error("Image attachments are not supported by the selected runtime adapter.");
    if (clientMessageId) {
      const existing = this.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
      if (existing) {
        const sameSkill = JSON.stringify(existing.skill ?? null) === JSON.stringify(prepared.skill ?? null);
        if (existing.text === prepared.visibleText && sameSkill) return {};
        throw new Error(`Claude transcript already contains a conflicting message id '${clientMessageId}'.`);
      }
    }
    if (input.delivery !== "prompt" && this.streaming) throw new Error("Claude Code print mode cannot steer or queue a live turn.");
    // Persist the visible message as soon as the runtime accepts it; the
    // transport separately records the attempt before creating a child.
    const user: UiMessage = {
      id: `claude-user-${clientMessageId ?? Date.now()}`,
      ...(clientMessageId ? { clientMessageId } : {}),
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
        ...(clientMessageId ? { clientMessageId } : {}),
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
  async waitForIdle(): Promise<void> {
    if (!this.streaming) return;
    await new Promise<void>((resolve) => {
      const check = () => this.streaming ? setTimeout(check, 10).unref?.() : resolve();
      check();
    });
  }
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
