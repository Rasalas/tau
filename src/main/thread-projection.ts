import { branchRecords } from "./branch-records.js";
import { IndexedTranscript } from "./indexed-transcript.js";
import { PersistedTranscriptReader } from "./persisted-transcript-reader.js";
import { localTranscriptPage } from "./host-transcript.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import type { HostSnapshot, UiComposerCommand, UiMessage, UiModel, UiTurnActivity } from "../shared/contracts.js";
import { catalogFromSnapshot, type HostCatalog, type TranscriptPage } from "../shared/host-protocol.js";
import { resolveClientTurnIdentity } from "../shared/transcript-turn.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { taskProgressFromMessages, taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import { bridgeHostSnapshot, bridgeMessageMapping } from "./bridge-snapshot.js";
import {
  EMPTY_PINS,
  cleanThreadTitle,
  firstSentence,
  isVisibleMessage,
  lastTurnActivityFromMessages,
  mapMessage,
  safeSessionTitle,
  turnActivityHistoryFromMessages,
  visibleTitleText,
  type MessageMappingOptions,
} from "./host-messages.js";
import type { HostThread } from "./host-extensions.js";
import { publicThreadTools, type HostPublicToolOptions, type HostPublicTools } from "./public-thread-tools.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { inStartOrder } from "./kit-message-order.js";
import { isPiBackend, isThreadRuntime, type ThreadRuntime } from "./thread-runtime.js";

export { branchRecords, type BranchRecord } from "./branch-records.js";

/** The thread's interaction mode and the modes it offers, and whether it keeps goals; nothing when it offers none. */
function threadModes(thread: ThreadRuntime): { mode?: string; modes?: string[]; goals?: boolean } {
  const capability = thread.backend.capabilities.mode;
  const modes = capability?.modes() ?? [];
  return {
    ...(modes.length > 0 ? { mode: capability!.current(), modes: [...modes] } : {}),
    ...(thread.backend.capabilities.goals ? { goals: true } : {}),
  };
}

export class ThreadProjection {
  private readonly pinnedCache = new WeakMap<ThreadRuntime, { size: number; leaf: unknown; revision: string; pinned: ReadonlySet<string> }>();
  private readonly pinProviderIds = new WeakMap<object, number>();
  private nextPinProviderId = 0;

  constructor(
    private readonly clientTurns: ClientTurnLedger,
    private readonly attachedSnapshot: () => PiBridgeSnapshot | undefined,
    private readonly entryPinProviders: ReadonlySet<(thread: HostThread) => Iterable<string>>,
    private readonly hostThread: (thread: ThreadRuntime) => HostThread,
    private readonly reportPinFailure: (error: unknown) => void,
    private readonly transcripts = new PersistedTranscriptReader(),
  ) {}

  composerCommands(thread: ThreadRuntime): UiComposerCommand[] {
    return thread.backend.composerCommands();
  }

  isExtensionCommand(thread: ThreadRuntime, text: string): boolean {
    if (!text.startsWith("/")) return false;
    const commandName = text.slice(1).split(/[ \t\r\n]/u, 1)[0];
    return this.composerCommands(thread).some((command) => command.source === "extension" && command.name === commandName);
  }

  mapping(thread?: LiveTurnState): MessageMappingOptions {
    if (isThreadRuntime(thread)) return {
      runtimeAdapter: thread.runtimeAdapter,
      skillCommands: this.composerCommands(thread),
      pinned: this.pinnedEntries(thread),
    };
    return bridgeMessageMapping(this.attachedSnapshot());
  }

  attachedHostSnapshot(): HostSnapshot {
    const snapshot = this.attachedSnapshot();
    if (!snapshot) throw new Error("Pi bridge snapshot is unavailable.");
    return bridgeHostSnapshot(snapshot, this.clientTurns);
  }

  branchMessages(thread: ThreadRuntime): unknown[] {
    const records = branchRecords(thread.entries, knownSkillNames(this.composerCommands(thread)));
    // Once per call: every read of `thread.entries` walks the whole branch.
    const mapping = this.mapping(thread);
    return records.map(({ record, raw }, index) => {
      const mapped = mapMessage(record, index, mapping);
      const identity = mapped?.role === "user"
        ? resolveClientTurnIdentity(
          mapped,
          raw ? this.clientTurns.identityForRaw(raw) ?? this.clientTurns.identityForMessage(thread.threadId, mapped) : undefined,
        )
        : undefined;
      if (identity && raw && mapped) this.clientTurns.remember(thread.threadId, mapped, identity, raw);
      return { ...record, ...(identity ?? {}) };
    });
  }

  /** `branchMessages`: the thread's, when the caller has just read them. */
  messages(thread: ThreadRuntime, branchMessages?: unknown[]): UiMessage[] {
    const conversation = thread.backend.capabilities.conversation;
    const messages: UiMessage[] = isPiBackend(thread) ? [...conversation?.history() ?? []] : [];
    if (isPiBackend(thread)) {
      const mapping = this.mapping(thread);
      messages.push(...(branchMessages ?? this.branchMessages(thread)).slice(conversation?.offset ?? 0)
        .map((message, index) => mapMessage(message, index, mapping))
        .filter((message): message is UiMessage => isVisibleMessage(message, mapping.pinned)));
    }
    messages.push(...this.adapterMessages(thread));
    return messages;
  }

  /** One history page without building a host snapshot or discovering models.
   * Pi exposes a cheap leaf id but only a whole-branch journal read. Build the
   * persisted reader's index once per branch revision and reuse its cache.
   */
  async transcriptPage(thread: ThreadRuntime, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    if (thread.backend.capabilities.conversation) return localTranscriptPage(thread.threadId, this.messages(thread), [], isPiBackend(thread) ? [...thread.backend.capabilities.conversation.activity(), ...turnActivityHistoryFromMessages(this.branchMessages(thread))] : thread.adapterActivity, true, cursor);
    const paging = thread.backend.capabilities.transcriptPaging;
    if (paging) return paging.page(cursor);
    if (!isPiBackend(thread)) return localTranscriptPage(
      thread.threadId, this.messages(thread), [], thread.adapterActivity, true, cursor,
    );
    const tree = thread.backend.capabilities.tree;
    // A backend without a branch revision cannot safely retain a live index.
    if (!tree) {
      const records = this.branchMessages(thread);
      return localTranscriptPage(thread.threadId, this.messages(thread, records),
        taskProgressHistoryFromMessages(records), turnActivityHistoryFromMessages(records), true, cursor);
    }
    const build = () => {
      const commands = this.composerCommands(thread);
      const records = branchRecords(thread.entries, knownSkillNames(commands)).map(({ record }) => record);
      const mapping = this.mapping(thread);
      const messages = records.map((record, index) => mapMessage(record, index, mapping))
        .filter((message): message is UiMessage => isVisibleMessage(message, mapping.pinned));
      return new IndexedTranscript(thread.threadId, messages,
        taskProgressHistoryFromMessages(records), turnActivityHistoryFromMessages(records));
    };
    const tail = this.adapterMessages(thread);
    const page = this.transcripts.livePage(thread, JSON.stringify([
      thread.threadId, thread.backend.providerSessionId, tree.leafEntryId(), this.composerCommands(thread), this.pinsRevision,
    ]), build, cursor, tail);
    // Correlation can arrive after an index was built. Consult the bounded
    // live ledger for this page only, preserving authoritative journal ids.
    return { ...page, messages: page.messages.map((message) => {
      if (message.role !== "user") return message;
      const entry = message.sourceEntryId ? thread.runtime?.session?.sessionManager?.getEntry(message.sourceEntryId) : undefined;
      const raw = entry?.type === "message" ? entry.message : undefined;
      const identity = resolveClientTurnIdentity(message,
        (raw ? this.clientTurns.identityForRaw(raw) : undefined) ?? this.clientTurns.identityForMessage(thread.threadId, message));
      if (identity && raw) this.clientTurns.remember(thread.threadId, message, identity, raw);
      return identity ? { ...message, ...identity } : message;
    }) };
  }

  private adapterMessages(thread: ThreadRuntime): UiMessage[] {
    const adapter = [...thread.adapterMessages];
    const live = thread.liveAssistant;
    if (live?.text) adapter.push({
      id: live.id, role: "assistant", text: live.text,
      thinking: live.thinking || undefined, timestamp: live.timestamp,
    });
    return inStartOrder(adapter);
  }

  turnActivity(thread: ThreadRuntime, branchMessages: unknown[]): UiTurnActivity | undefined {
    const activity = lastTurnActivityFromMessages(branchMessages);
    if (!activity || thread.tools.size === 0) return activity;
    return {
      ...activity,
      tools: activity.tools.map((tool) => tool.status === "running" ? thread.tools.get(tool.id) ?? tool : tool),
    };
  }

  /** Reuses workbench activity, including the latest running preview, without result/file reads. */
  publicTools(thread: ThreadRuntime, options: HostPublicToolOptions): HostPublicTools {
    const history = isPiBackend(thread)
      ? [...thread.backend.capabilities.conversation?.activity() ?? [], ...turnActivityHistoryFromMessages(this.branchMessages(thread).map((raw) => {
        if (!raw || typeof raw !== "object" || (raw as { role?: unknown }).role !== "toolResult") return raw;
        // A result cannot rename a private/custom call to an allowed text tool.
        const { toolName: _name, ...result } = raw as Record<string, unknown>;
        return result;
      }))]
      : thread.adapterActivity;
    return publicThreadTools(history.flatMap((entry) => entry.tools.map((tool) => {
      const live = tool.status === "running" ? thread.tools.get(tool.id) : undefined;
      return live && live.name === tool.name ? live : tool;
    })), options);
  }

  /** The running turn's tools of a backend without a journal, with their latest output. */
  private adapterTurnActivity(thread: ThreadRuntime): UiTurnActivity | undefined {
    const entry = thread.adapterActivity.at(-1);
    if (!entry || entry.status !== "running" || entry.tools.length === 0) return undefined;
    return {
      tools: entry.tools.map((tool) => tool.status === "running" ? thread.tools.get(tool.id) ?? tool : tool),
      ...(entry.anchorMessageId ? { anchorMessageId: entry.anchorMessageId } : {}),
    };
  }

  pinnedEntries(thread: ThreadRuntime): ReadonlySet<string> {
    if (this.entryPinProviders.size === 0 || !isPiBackend(thread)) return EMPTY_PINS;
    const entries = thread.entries;
    const leaf = entries.at(-1);
    const revision = this.pinsRevision;
    const cached = this.pinnedCache.get(thread);
    if (cached && cached.size === entries.length && cached.leaf === leaf && cached.revision === revision) return cached.pinned;
    const pinned = this.pinsFor(this.hostThread(thread));
    this.pinnedCache.set(thread, { size: entries.length, leaf, revision, pinned });
    return pinned;
  }

  get hasPinProviders(): boolean { return this.entryPinProviders.size > 0; }

  /** Registration identity changes even when an extension reload leaves the file unchanged. */
  get pinsRevision(): string {
    return [...this.entryPinProviders].map((provider) => {
      let id = this.pinProviderIds.get(provider);
      if (id === undefined) { id = ++this.nextPinProviderId; this.pinProviderIds.set(provider, id); }
      return id;
    }).join(",");
  }

  /** What the registered providers pin for one thread, live or read from a file. */
  pinsFor(thread: HostThread): ReadonlySet<string> {
    if (this.entryPinProviders.size === 0) return EMPTY_PINS;
    const pinned = new Set<string>();
    for (const provider of this.entryPinProviders) {
      try { for (const id of provider(thread)) pinned.add(id); }
      catch (error) { this.reportPinFailure(error); }
    }
    return pinned;
  }

  /**
   * The catalog half of `hostSnapshot`, without mapping a single message: a
   * model or thinking-level change costs the same in a thread of any length.
   * Host-wide fields (runtime backends, completion models) are the caller's.
   */
  catalog(thread: ThreadRuntime | undefined, models: UiModel[], extensionCount: number): HostCatalog {
    if (this.attachedSnapshot()) return catalogFromSnapshot({ ...this.attachedHostSnapshot(), models });
    if (!thread) throw new Error("Pi runtime is not ready");
    const pi = isPiBackend(thread);
    const state = thread.state;
    const view = thread.backend.catalogView();
    return {
      sessionId: thread.threadId,
      backendKind: thread.backend.kind,
      models: [...models],
      model: view.model,
      runtimeCapabilities: thread.runtimeAdapter.capabilities,
      thinkingLevel: view.thinkingLevel,
      thinkingLevels: [...view.thinkingLevels],
      ...threadModes(thread),
      allTools: [...view.allTools],
      composerCommands: this.composerCommands(thread).map((command) => ({ ...command })),
      extensionCount: pi ? extensionCount : state.extensionCount,
      supportsImageInput: state.supportsImageInput ?? false,
    };
  }

  hostSnapshot(thread: ThreadRuntime | undefined, models: UiModel[], cwd: string, extensionCount: number): HostSnapshot {
    const attached = this.attachedSnapshot();
    if (attached) return { ...this.attachedHostSnapshot(), models };
    if (!thread) throw new Error("Pi runtime is not ready");
    const branchMessages = isPiBackend(thread) ? this.branchMessages(thread) : [];
    const messages = this.messages(thread, branchMessages);
    const firstUserMessage = messages.find((message) => message.role === "user");
    if (!isPiBackend(thread)) {
      const externalState = thread.state;
      const externalView = thread.backend.catalogView();
      const turnActivity = this.adapterTurnActivity(thread);
      return {
        cwd: thread.cwd,
        threadId: thread.threadId,
        providerSessionId: thread.backend.providerSessionId,
        sessionId: thread.threadId,
        sessionName: safeSessionTitle(externalState.title) || safeSessionTitle(thread.adapterTitle),
        sessionTitle: cleanThreadTitle(safeSessionTitle(externalState.title) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
        ...(externalView.model ? { model: externalView.model } : {}),
        runtimeCapabilities: thread.runtimeAdapter.capabilities,
        backendKind: thread.backend.kind,
        models,
        thinkingLevel: externalView.thinkingLevel,
        thinkingLevels: [...externalView.thinkingLevels],
        ...threadModes(thread),
        messages,
        isStreaming: thread.adapterStreaming || externalState.streaming,
        isCompacting: thread.isCompacting || thread.compactionPending,
        activeTools: [...externalState.activeTools],
        ...(turnActivity ? { turnActivity } : {}),
        turnActivityHistory: thread.adapterActivity.map((entry) => ({ ...entry, tools: [...entry.tools] })),
        turnActivityHistoryComplete: true,
        taskProgress: undefined,
        taskHistory: [],
        allTools: [...externalView.allTools],
        composerCommands: this.composerCommands(thread),
        extensionCount: externalState.extensionCount,
        historyCompleteness: "complete",
        supportsImageInput: externalState.supportsImageInput,
        ...(externalView.contextUsage ? { contextUsage: externalView.contextUsage } : {}),
        ...(externalView.usage ? { usage: externalView.usage } : {}),
      };
    }
    const state = thread.state;
    const view = thread.backend.catalogView();
    return {
      cwd,
      threadId: thread.threadId,
      providerSessionId: thread.backend.providerSessionId,
      sessionId: thread.threadId,
      sessionName: safeSessionTitle(state.title),
      sessionTitle: cleanThreadTitle(safeSessionTitle(state.title) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
      model: view.model,
      runtimeCapabilities: thread.runtimeAdapter.capabilities,
      backendKind: thread.backend.kind,
      models,
      thinkingLevel: view.thinkingLevel,
      thinkingLevels: [...view.thinkingLevels],
      ...threadModes(thread),
      messages,
      isStreaming: state.streaming || thread.adapterStreaming,
      isCompacting: thread.isCompacting || thread.compactionPending,
      activeTools: [...state.activeTools],
      turnActivity: this.turnActivity(thread, branchMessages),
      turnActivityHistory: [...thread.backend.capabilities.conversation?.activity() ?? [], ...turnActivityHistoryFromMessages(branchMessages)],
      taskProgress: taskProgressFromMessages(branchMessages),
      taskHistory: taskProgressHistoryFromMessages(branchMessages),
      allTools: [...view.allTools],
      composerCommands: this.composerCommands(thread),
      extensionCount,
      historyCompleteness: "complete",
      supportsImageInput: state.supportsImageInput,
      contextUsage: view.contextUsage,
      usage: view.usage,
    };
  }
}
