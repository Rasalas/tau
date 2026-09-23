import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import type { HostSnapshot, UiComposerCommand, UiMessage, UiModel, UiTurnActivity } from "../shared/contracts.js";
import { catalogFromSnapshot, type HostCatalog } from "../shared/host-protocol.js";
import { branchMessagesWithClientMessageIds } from "../shared/client-message-correlation.js";
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
import type { LiveTurnState } from "./live-turn-state.js";
import { isPiBackend, isThreadRuntime, type ThreadRuntime } from "./thread-runtime.js";

/** One message entry of a branch, in the shape the transcript maps. */
export interface BranchRecord {
  record: Record<string, unknown>;
  /** The runtime's own message object; the key the client-turn ledger correlates on. */
  raw?: object;
}

/**
 * Projects the message entries of a branch, resolving each user turn's client
 * message id from the markers beside it. A live thread reads its runtime's
 * journal and a released one its session file, and both arrive here.
 */
export function branchRecords(entries: readonly unknown[], skillNames: Iterable<string>): BranchRecord[] {
  const messages = branchMessagesWithClientMessageIds(entries, skillNames);
  let messageIndex = 0;
  return entries.flatMap((entry) => {
    const typed = entry as { type?: unknown; id?: unknown; message?: unknown };
    if (typed.type !== "message") return [];
    const projected = messages[messageIndex++] as Record<string, unknown>;
    const raw = typed.message && typeof typed.message === "object" ? typed.message as object : undefined;
    return [{ record: { ...projected, tauEntryId: typed.id }, ...(raw ? { raw } : {}) }];
  });
}

export class ThreadProjection {
  private readonly pinnedCache = new WeakMap<ThreadRuntime, { size: number; leaf: unknown; pinned: ReadonlySet<string> }>();

  constructor(
    private readonly clientTurns: ClientTurnLedger,
    private readonly attachedSnapshot: () => PiBridgeSnapshot | undefined,
    private readonly entryPinProviders: ReadonlySet<(thread: HostThread) => Iterable<string>>,
    private readonly hostThread: (thread: ThreadRuntime) => HostThread,
    private readonly reportPinFailure: (error: unknown) => void,
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

  messages(thread: ThreadRuntime): UiMessage[] {
    const messages: UiMessage[] = [];
    if (isPiBackend(thread)) {
      const mapping = this.mapping(thread);
      messages.push(...this.branchMessages(thread)
        .map((message, index) => mapMessage(message, index, mapping))
        .filter((message): message is UiMessage => isVisibleMessage(message, mapping.pinned)));
    }
    messages.push(...thread.adapterMessages);
    const live = thread.liveAssistant;
    if (live?.text) messages.push({
      id: live.id,
      role: "assistant",
      text: live.text,
      thinking: live.thinking || undefined,
      timestamp: live.timestamp,
    });
    return messages;
  }

  turnActivity(thread: ThreadRuntime, branchMessages: unknown[]): UiTurnActivity | undefined {
    const activity = lastTurnActivityFromMessages(branchMessages);
    if (!activity || thread.tools.size === 0) return activity;
    return {
      ...activity,
      tools: activity.tools.map((tool) => tool.status === "running" ? thread.tools.get(tool.id) ?? tool : tool),
    };
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
    const cached = this.pinnedCache.get(thread);
    if (cached && cached.size === entries.length && cached.leaf === leaf) return cached.pinned;
    const pinned = this.pinsFor(this.hostThread(thread));
    this.pinnedCache.set(thread, { size: entries.length, leaf, pinned });
    return pinned;
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
    const messages = this.messages(thread);
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
        messages,
        isStreaming: thread.adapterStreaming || externalState.streaming,
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
    const branchMessages = this.branchMessages(thread);
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
      messages,
      isStreaming: state.streaming || thread.adapterStreaming,
      activeTools: [...state.activeTools],
      turnActivity: this.turnActivity(thread, branchMessages),
      turnActivityHistory: turnActivityHistoryFromMessages(branchMessages),
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
