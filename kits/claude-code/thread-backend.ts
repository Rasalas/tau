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
  type ThreadRuntimeEvent,
  type ThreadTitleSource,
  type UiComposerCommand,
  type UiContextUsage,
  type UiMessage,
  type UiModel,
  type UiSkillDraft,
  type UiThreadUsage,
} from "tau/host-extension";
import { assertClaudePermissionPolicySupported, runtimePermissionPolicy, type ClaudeCodeAgentRuntimeAdapter } from "./runtime-adapter.js";
import { addUsage, SdkTurnTranslator } from "./sdk-events.js";
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
  /** Whole messages, for a host that offers no event route. */
  onMessage?(message: UiMessage): void;
  /** The host's event route; with it the thread streams. */
  onEvent?(event: ThreadRuntimeEvent): void;
  projectName: string;
  branch?: string;
  permissionLevel?: () => RuntimePermissionLevel;
  now?(): number;
}

interface LiveTurn {
  translator: SdkTurnTranslator;
}

/**
 * Claude's complete thread owner. It never constructs an AgentSession or
 * consults Pi's SessionManager, model catalog, context window, or extensions.
 * One turn is one SDK query; its frames stream to the host as Tau events.
 */
export class ClaudeThreadRuntimeBackend implements ThreadRuntimeBackend {
  readonly kind = "claude-code" as const;
  readonly runtimeAdapter: ClaudeCodeAgentRuntimeAdapter;
  readonly turnReporting = "streamed" as const;
  readonly capabilities: ThreadBackendCapabilities = {};
  private record?: Awaited<ReturnType<ClaudeRuntimeSessionStore["get"]>>;
  private messages: UiMessage[] = [];
  private live?: LiveTurn;
  private title?: string;
  private titleSource?: ThreadTitleSource;
  private usage: UiThreadUsage = SdkTurnTranslator.emptyUsage();
  private contextUsage?: UiContextUsage;
  private model?: string;
  private readonly now: () => number;

  constructor(
    readonly threadId: string,
    readonly cwd: string,
    options: ClaudeThreadBackendOptions,
  ) {
    this.runtimeAdapter = options.adapter;
    this.store = options.store;
    this.options = options;
    this.now = options.now ?? Date.now;
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
    if (record.usage) this.usage = { ...record.usage };
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
      streaming: this.live !== undefined,
      idle: this.live === undefined,
      hasMessages: this.messages.length > 0,
      ...(this.title ? { title: this.title } : {}),
      ...(this.titleSource ? { titleSource: this.titleSource } : {}),
      activeTools: [...(this.live?.translator.running.values() ?? [])].map((tool) => tool.name),
      supportsImageInput: false,
      extensionCount: 0,
    };
  }

  catalogView(): ThreadCatalogView {
    const model: UiModel | undefined = this.model ? { provider: "anthropic", id: this.model, name: this.model } : undefined;
    return {
      ...(model ? { model } : {}),
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
      ...(this.usage.turns > 0 ? { usage: { ...this.usage } } : {}),
      ...(this.contextUsage ? { contextUsage: { ...this.contextUsage } } : {}),
    };
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
    if (this.live) throw new Error("Claude Code cannot steer or queue a live turn yet.");
    // Persist the visible message as soon as the runtime accepts it; the
    // transport separately records the attempt before creating a child.
    const user: UiMessage = {
      id: `claude-user-${clientMessageId ?? this.now()}`,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(input.identity?.clientTurnId ? { clientTurnId: input.identity.clientTurnId } : {}),
      role: "user",
      text: prepared.visibleText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      timestamp: this.now(),
    };
    this.messages.push(user);
    await this.persist([user]);
    if (!this.title) {
      const title = derivedClaudeTitle(prepared.visibleText);
      if (title) {
        this.title = title;
        this.titleSource = "derived";
        await this.store.setTitle(this.threadId, this.cwd, title, "derived");
      }
    }
    const translator = new SdkTurnTranslator(this.now);
    this.live = { translator };
    this.report({ type: "turn-started" });
    this.deliverMessage(user);
    input.onAdmitted?.(true);
    try {
      await this.runtimeAdapter.stream({
        cwd: this.cwd,
        tauThreadId: this.threadId,
        sessionId: this.providerSessionId,
        text: prepared.runtimeText,
        delivery: input.delivery,
        ...(clientMessageId ? { clientMessageId } : {}),
        permissionLevel,
        signal: input.signal,
      }, (frame) => { for (const event of translator.push(frame)) this.handleEvent(event); });
      await this.finishTurn(translator);
      this.report({ type: "turn-settled", status: "completed" });
      return { assistantText: translator.outcome?.texts.join("\n\n") ?? "" };
    } catch (error) {
      await this.finishTurn(translator);
      if (error instanceof Error && error.name === "AbortError") {
        this.report({ type: "turn-settled", status: "interrupted" });
        return {};
      }
      this.report({ type: "notice", message: error instanceof Error ? error.message : String(error), level: "error" });
      this.report({ type: "turn-settled", status: "error" });
      throw error;
    } finally {
      this.live = undefined;
      this.record = await this.store.get(this.threadId);
    }
  }

  /** What one turn leaves behind: its messages are already in; usage and facts follow. */
  private async finishTurn(translator: SdkTurnTranslator): Promise<void> {
    if (translator.facts.model) this.model = translator.facts.model;
    const outcome = translator.outcome;
    if (!outcome) return;
    this.usage = addUsage(this.usage, outcome.usage);
    if (outcome.contextUsage) this.contextUsage = outcome.contextUsage;
    await this.store.recordUsage(this.threadId, this.cwd, this.usage);
    this.report({ type: "usage" });
  }

  private handleEvent(event: ThreadRuntimeEvent): void {
    if (event.type === "assistant-end") {
      this.messages.push(event.message);
      void this.persist([event.message]);
      this.deliverMessage(event.message);
      return;
    }
    this.report(event);
  }

  /** A host with an event route gets the message as an event; an older one as a whole message. */
  private deliverMessage(message: UiMessage): void {
    if (this.options.onEvent) {
      this.options.onEvent(message.role === "user" ? { type: "user-message", message } : { type: "assistant-end", message });
      return;
    }
    this.options.onMessage?.(message);
  }

  private report(event: ThreadRuntimeEvent): void {
    this.options.onEvent?.(event);
  }

  async abort(): Promise<void> { await this.runtimeAdapter.transport.abort?.(this.threadId); }
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
    if (!this.live) return;
    await new Promise<void>((resolve) => {
      const check = () => this.live ? setTimeout(check, 10).unref?.() : resolve();
      check();
    });
  }
  async dispose(): Promise<void> { if (this.live) await this.abort(); }

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
