import { clientMessageFingerprint, type AgentRuntimeAdapter, type HostBackendOpenContext, type HostBackendThreadRecord, type HostMachineServices, type HostPushEvent, type HostRuntimeBackendProvider, type HostTranscriptCursor, type PreparedPrompt, type ThreadBackendCapabilities, type ThreadBackendPromptInput, type ThreadBackendPromptResult, type ThreadBackendState, type ThreadCatalogView, type ThreadCatalogWriteCapability, type ThreadRuntimeBackend, type ThreadRuntimeEvent, type ThreadTitleSource, type TranscriptPage, type UiComposerCommand, type UiMessage, type UiModel, type UiPromptImageAttachment, type UiRuntimeCatalog, type UiSession, type UiThreadUsage, type UsageTally } from "tau/host-extension";
import { machineCommandError, machineMethodError, type MachineOperation } from "./compatibility.js";
import { ENVIRONMENTS_EXTENSION_ID, THREAD_MODEL_COMMAND, THREAD_RENAME_COMMAND, THREAD_SEND_COMMAND } from "./protocol.js";

/** How long a machine's model list serves a picker before it is asked again. */
const MODELS_FRESH_MS = 30_000;
const MODELS_TIMEOUT_MS = 5_000;
/** A message with images may be large; one piece goes in one frame. */
const SEND_TIMEOUT_MS = 120_000;

export function machineThreadId(machine: string, sessionId: string): string {
  return `${machine}~${sessionId}`;
}

export function parseMachineThreadId(threadId: string): { machine: string; sessionId: string } | undefined {
  const separator = threadId.indexOf("~");
  return separator > 0 && separator < threadId.length - 1 ? { machine: threadId.slice(0, separator), sessionId: threadId.slice(separator + 1) } : undefined;
}

/** Keep the remote host's prices: provider-less tallies cannot pick up local model overrides. */
export function machineUsageTallies(usage: UiThreadUsage): UsageTally[] {
  const subscription = usage.subscription;
  const billed: UsageTally = {
    inputTokens: usage.inputTokens - (subscription?.inputTokens ?? 0),
    outputTokens: usage.outputTokens - (subscription?.outputTokens ?? 0),
    cacheReadTokens: usage.cacheReadTokens - (subscription?.cacheReadTokens ?? 0),
    cacheWriteTokens: usage.cacheWriteTokens - (subscription?.cacheWriteTokens ?? 0),
    totalTokens: usage.totalTokens - (subscription?.totalTokens ?? 0),
    turns: usage.turns - (subscription?.turns ?? 0),
    costUsd: usage.costUsd,
  };
  return subscription ? [billed, {
    billing: "subscription", inputTokens: subscription.inputTokens, outputTokens: subscription.outputTokens,
    cacheReadTokens: subscription.cacheReadTokens, cacheWriteTokens: subscription.cacheWriteTokens,
    totalTokens: subscription.totalTokens, turns: subscription.turns, costUsd: subscription.apiValueUsd,
  }] : [billed];
}

export function toRuntimeEvents(push: HostPushEvent): ThreadRuntimeEvent[] {
  switch (push.type) {
    case "assistant-start": return [{ type: push.type, id: push.id, timestamp: push.timestamp }];
    case "assistant-delta":
    case "assistant-thinking": return [{ type: push.type, id: push.id, delta: push.delta }];
    case "assistant-end":
    case "user-message": return [{ type: push.type, message: push.message }];
    case "tool-start":
    case "tool-end": return [{ type: push.type, tool: push.tool }];
    case "tool-end-delta": return [{ type: "tool-end", tool: { ...push.tool, outputDeferred: true, outputLength: push.length } }];
    case "tool-update": return [{ type: push.type, id: push.id, output: push.output }];
    case "queue": return [{ type: push.type, steering: push.steering, followUp: push.followUp }];
    case "notice": return [{ type: push.type, message: push.message, level: push.level }];
    case "agent-status": return [push.running ? { type: "turn-started" } : { type: "turn-settled", status: "completed" }];
    case "host-update":
      if (push.update.type !== "run") return [];
      return [push.update.event === "started" ? { type: "turn-started" } : { type: "turn-settled", status: push.update.event === "aborted" ? "interrupted" : "completed" }];
    default: return [];
  }
}

function sessionOn(machines: HostMachineServices, machine: string, sessionId: string): UiSession | undefined {
  return machines.index?.(machine)?.sessions.find((session) => session.id === sessionId);
}

function record(machine: { id: string; name: string }, session: UiSession): HostBackendThreadRecord {
  return {
    threadId: machineThreadId(machine.id, session.id), cwd: session.projectPath, title: session.title,
    updatedAt: session.modifiedAt, messages: [], messageCount: session.messageCount,
    ...(session.workspaceId ? { workspace: { workspaceId: session.workspaceId, displayPath: session.projectDisplayPath ?? session.projectPath } } : {}),
    ...(session.model && session.modelProvider ? { model: { provider: session.modelProvider, id: session.model } } : {}),
    ...(session.usage ? { usage: machineUsageTallies(session.usage) } : {}),
    machine: { id: machine.id, name: machine.name, ...(session.backendKind ? { backendKind: session.backendKind } : {}), ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}) },
  };
}

function delivery(input: { delivery?: string; queued?: boolean }): "prompt" | "steer" | "queue" {
  return input.delivery === "steer" ? "steer" : input.delivery === "followUp" || input.queued ? "queue" : "prompt";
}

function adapter(machines: HostMachineServices): AgentRuntimeAdapter {
  return {
    id: "machine", capabilities: { skillInvocationDialect: "pi", ownsModelSelection: false, interactiveApprovals: true },
    transport: {
      sendPrompt: async (input) => {
        const parsed = parseMachineThreadId(input.tauThreadId);
        if (!parsed) throw new Error("Invalid machine thread id.");
        await machines.request(parsed.machine, "send-to-thread", [parsed.sessionId, input.text, delivery(input)]);
        return {};
      },
    },
  };
}

export function createMachineBackendProvider(machines: HostMachineServices): HostRuntimeBackendProvider {
  const runtimeAdapter = adapter(machines);
  return {
    kind: "machine", label: "Another machine", order: 90, hidden: true, adapter: runtimeAdapter,
    listThreads: async () => machines.list().flatMap((machine) => (machines.index?.(machine.id)?.sessions ?? [])
      .filter((session) => session.backendKind !== "machine" && !session.parentThreadId && session.messageCount > 0).map((session) => record(machine, session))),
    lookup: async (threadId) => {
      const parsed = parseMachineThreadId(threadId);
      const machine = parsed && machines.list().find((entry) => entry.id === parsed.machine);
      const session = parsed && machine && sessionOn(machines, parsed.machine, parsed.sessionId);
      return machine && session && session.backendKind !== "machine" ? record(machine, session) : undefined;
    },
    open: async (threadId, cwd, { resume }, context) => {
      if (!resume) throw new Error("Start threads on another machine with Run on.");
      const parsed = parseMachineThreadId(threadId);
      if (!parsed) throw new Error("Invalid machine thread id.");
      const backend = new MachineThreadBackend(threadId, cwd, machines, context, runtimeAdapter);
      await backend.start("resume");
      return backend;
    },
    composerCommands: () => [],
  };
}

export class MachineThreadBackend implements ThreadRuntimeBackend {
  readonly kind = "machine";
  readonly turnReporting = "streamed";
  readonly capabilities: ThreadBackendCapabilities;
  readonly runtimeAdapter: AgentRuntimeAdapter;
  readonly providerSessionId: string;
  private readonly machine: string;
  private name: string;
  private title?: string;
  private model?: ThreadCatalogView["model"];
  private known?: { at: number; models: UiModel[] };
  private modelsPending?: Promise<UiModel[]>;
  private usage?: UiThreadUsage;
  private row?: UiSession;
  private streaming = false;
  private hasMessages = false;
  private readonly activeTools = new Set<string>();
  private readonly delivered = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly questions = new Map<string, object>();
  private stopFollowing?: () => void;
  private pushWork = Promise.resolve();
  private newest?: TranscriptPage;
  private needsTranscriptRefresh = false;
  private turnError?: string;
  private interrupted = false;
  private disposed = false;

  constructor(readonly threadId: string, readonly cwd: string, private readonly machines: HostMachineServices, private readonly context: HostBackendOpenContext, runtimeAdapter = adapter(machines)) {
    const parsed = parseMachineThreadId(threadId);
    if (!parsed) throw new Error("Invalid machine thread id.");
    this.machine = parsed.machine;
    this.providerSessionId = parsed.sessionId;
    this.runtimeAdapter = runtimeAdapter;
    this.capabilities = { catalogWrite: this.catalogWrite() };
    this.name = machines.list().find((entry) => entry.id === this.machine)?.name ?? this.machine;
    this.streaming = machines.running?.(this.machine)?.has(this.providerSessionId) ?? false;
    this.syncRow();
  }

  async start(mode: "create" | "resume"): Promise<void> {
    if (mode !== "resume") throw new Error("Start threads on another machine with Run on.");
    if (!this.machines.followThread) throw new Error("This host cannot follow threads on another machine.");
    if (this.stopFollowing) return;
    this.stopFollowing = this.machines.followThread(this.machine, this.providerSessionId, (push) => {
      this.pushWork = this.pushWork.then(() => this.receive(push)).catch((error: unknown) => {
        if (!this.disposed) this.context.onEvent({ type: "notice", message: error instanceof Error ? error.message : String(error), level: "warning" });
      });
    });
    try {
      this.newest = await this.page();
      for (const message of this.newest.messages) this.delivered.add(message.id);
      this.hasMessages ||= this.newest.messages.length > 0;
    } catch (error) {
      this.stopFollowing();
      this.stopFollowing = undefined;
      throw error;
    }
  }

  private syncRow(): void {
    const machine = this.machines.list().find((entry) => entry.id === this.machine);
    if (machine) this.name = machine.name;
    const session = sessionOn(this.machines, this.machine, this.providerSessionId);
    if (!session || session === this.row) return;
    this.row = session;
    this.title = session.title;
    this.hasMessages ||= session.messageCount > 0;
    if (session.model && session.modelProvider) this.model = { provider: session.modelProvider, id: session.model, name: session.model };
    if (session.usage) this.usage = session.usage;
  }

  state(): ThreadBackendState {
    this.syncRow();
    return { streaming: this.streaming, idle: !this.streaming, hasMessages: this.hasMessages, title: this.title, activeTools: [...this.activeTools], supportsImageInput: this.takesImages(), extensionCount: 0 };
  }

  /** The home machine's catalog says whether this thread's model reads images; unknown counts as no. */
  private takesImages(): boolean {
    const model = this.model;
    return model !== undefined && this.known?.models.some((entry) => entry.provider === model.provider && entry.id === model.id && entry.images === true) === true;
  }

  private async command<T>(command: string, input: unknown, operation: MachineOperation, timeoutMs?: number): Promise<T> {
    if (this.machines.list().find((entry) => entry.id === this.machine)?.status !== "connected") throw new Error(`${this.name} is not reachable right now.`);
    try { return await this.machines.call(this.machine, ENVIRONMENTS_EXTENSION_ID, command, input, timeoutMs ? { timeoutMs } : undefined) as T; }
    catch (error) { throw machineCommandError(error, this.name, command, operation); }
  }

  private catalogWrite(): ThreadCatalogWriteCapability {
    return {
      setModel: async (provider, id) => {
        await this.command(THREAD_MODEL_COMMAND, { sessionId: this.providerSessionId, provider, id }, "change models from here");
        this.model = { provider, id, name: this.known?.models.find((entry) => entry.provider === provider && entry.id === id)?.name ?? id };
      },
      setThinkingLevel: async () => { throw new Error(`The thinking level of a thread on ${this.name} cannot be changed from here yet.`); },
    };
  }

  catalogView(): ThreadCatalogView {
    this.syncRow();
    return { ...(this.model ? { model: this.model } : {}), ...(this.usage ? { usage: this.usage } : {}), thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] };
  }

  async preparePrompt(text: string): Promise<PreparedPrompt> {
    return {
      tauThreadId: this.threadId, providerSessionId: this.providerSessionId, sessionId: this.threadId,
      backendKind: this.kind, runtimeCapabilities: this.runtimeAdapter.capabilities,
      visibleText: text, runtimeText: text, sourceFingerprint: clientMessageFingerprint(text, []),
    };
  }

  async prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult> {
    this.syncRow();
    const attachments = input.attachments ?? [];
    const images = attachments.filter((attachment): attachment is UiPromptImageAttachment => attachment.kind === "image");
    if (images.length !== attachments.length) throw new Error(`Files stay on this computer; ${this.name} takes images only. Embed the file in the message.`);
    if (this.machines.list().find((entry) => entry.id === this.machine)?.status !== "connected") throw new Error(`${this.name} is not reachable right now.`);
    if (images.length) await this.command(THREAD_SEND_COMMAND, { sessionId: this.providerSessionId, text: input.text, delivery: delivery(input), attachments: images }, "take images from here", SEND_TIMEOUT_MS);
    else try { await this.machines.request(this.machine, "send-to-thread", [this.providerSessionId, input.text, delivery(input)]); }
    catch (error) { throw machineMethodError(error, this.name, "take messages from here"); }
    input.onAdmitted?.(true);
    return {};
  }

  async abort(): Promise<void> {
    const previous = this.interrupted;
    this.interrupted = true;
    try { await this.machines.request(this.machine, "abort", [this.providerSessionId]); }
    catch (error) { this.interrupted = previous; throw error; }
  }

  private page(cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    return this.machines.request(this.machine, "transcript-page", [this.providerSessionId, cursor]) as Promise<TranscriptPage>;
  }

  async transcript(): Promise<UiMessage[]> {
    let page = this.newest ?? await this.page();
    this.newest = undefined;
    let messages = [...page.messages];
    const cursors = new Set<HostTranscriptCursor>();
    while (page.olderCursor && messages.length < 2000 && !cursors.has(page.olderCursor)) {
      cursors.add(page.olderCursor);
      page = await this.page(page.olderCursor);
      const ids = new Set(messages.map((message) => message.id));
      messages.unshift(...page.messages.filter((message) => !ids.has(message.id)));
    }
    messages = messages.slice(-2000);
    for (const message of messages) this.delivered.add(message.id);
    this.hasMessages ||= messages.length > 0;
    return messages;
  }

  private async receive(push: HostPushEvent): Promise<void> {
    if (this.disposed) return;
    if ("sessionId" in push && push.sessionId !== undefined && push.sessionId !== this.providerSessionId) return;
    if (push.type === "host-update" && push.update.type === "run" && push.update.sessionId !== this.providerSessionId) return;
    if (push.type === "extension-ui-prompt") {
      if (push.prompt.sessionId !== this.providerSessionId || this.questions.has(push.prompt.id)) return;
      const pending = {};
      this.questions.set(push.prompt.id, pending);
      const { id, sessionId: _sessionId, ...prompt } = push.prompt;
      void this.context.ask(prompt).then(async (answer) => {
        if (this.disposed || this.questions.get(id) !== pending) return;
        this.questions.delete(id);
        await this.machines.request(this.machine, "answer-extension-ui", [id, answer]);
      }).catch((error: unknown) => {
        this.questions.delete(id);
        if (!this.disposed) this.context.onEvent({ type: "notice", level: "warning", message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (push.type === "extension-ui-resolved") { this.questions.delete(push.id); return; }
    if (push.type === "assistant-end-delta" || push.type === "tool-update-delta" || push.type === "tool-end-delta" || push.type === "thread-detail-compact") this.needsTranscriptRefresh = true;
    if (push.type === "tool-start") this.activeTools.add(push.tool.id);
    if (push.type === "tool-end" || push.type === "tool-end-delta") this.activeTools.delete(push.tool.id);
    if (push.type === "error" || push.type === "notice" && push.level === "error") this.turnError = push.message;
    if (push.type === "host-update" && push.update.type === "thread-detail") {
      const detail = push.update.detail;
      if (detail.sessionId !== this.providerSessionId) return;
      if (detail.usage) this.usage = detail.usage;
    }
    for (const event of toRuntimeEvents(push)) {
      if (event.type === "turn-started") {
        if (this.streaming) continue;
        this.streaming = true;
        this.turnError = undefined;
        this.interrupted = false;
      }
      if (event.type === "turn-settled") {
        if (!this.streaming && !this.needsTranscriptRefresh) continue;
        if (this.needsTranscriptRefresh) {
          try {
            const page = await this.page();
            if (this.disposed) return;
            for (const message of page.messages) if (!this.delivered.has(message.id)) {
              this.delivered.add(message.id);
              this.hasMessages = true;
              this.context.onMessage(message);
            }
          } catch (error: unknown) {
            if (!this.disposed) this.context.onEvent({ type: "notice", level: "warning", message: error instanceof Error ? error.message : String(error) });
          }
          this.needsTranscriptRefresh = false;
        }
        this.streaming = false;
        this.activeTools.clear();
        event.status = this.turnError ? "error" : this.interrupted ? "interrupted" : event.status;
        if (this.turnError) event.error = this.turnError;
        this.context.onEvent(event);
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
        continue;
      }
      if (event.type === "assistant-end" || event.type === "user-message") {
        this.delivered.add(event.message.id);
        this.hasMessages = true;
      }
      this.context.onEvent(event);
    }
  }

  async waitForIdle(): Promise<void> {
    await this.pushWork;
    if (this.streaming && !this.disposed) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopFollowing?.();
    this.stopFollowing = undefined;
    this.questions.clear();
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  async persist(_messages: readonly UiMessage[]): Promise<void> {}
  /** Only the user's own rename goes to the home machine, which names its threads itself. */
  async setTitle(title: string, source: ThreadTitleSource): Promise<void> {
    if (source !== "renamed") return;
    await this.command(THREAD_RENAME_COMMAND, { sessionId: this.providerSessionId, title }, "rename threads from here");
    this.title = title;
  }

  /** The models the home machine offers; a failed or slow answer keeps the last list. */
  async models(): Promise<UiModel[]> {
    if (this.known && Date.now() - this.known.at < MODELS_FRESH_MS) return this.known.models;
    this.modelsPending ??= (async () => {
      let models = this.known?.models ?? [];
      try {
        const catalog = await this.machines.request(this.machine, "runtime-catalog", [this.row?.backendKind ?? "pi"], { timeoutMs: MODELS_TIMEOUT_MS }) as UiRuntimeCatalog | undefined;
        models = catalog?.models ?? [];
      } catch { /* the picker keeps what it had */ }
      this.known = { at: Date.now(), models };
      return models;
    })().finally(() => { this.modelsPending = undefined; });
    return this.modelsPending;
  }
  composerCommands(): UiComposerCommand[] { return []; }
}
