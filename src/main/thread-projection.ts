import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import type { HostSnapshot, UiComposerCommand, UiMessage, UiModel, UiTurnActivity } from "../shared/contracts.js";
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
  modelSupportsImageInput,
  safeSessionTitle,
  turnActivityHistoryFromMessages,
  visibleTitleText,
  type MessageMappingOptions,
} from "./host-messages.js";
import type { HostThread } from "./host-extensions.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { isPiBackend, isThreadRuntime, type ThreadRuntime } from "./thread-runtime.js";

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
    const entries = thread.backend.branchEntries();
    const messages = branchMessagesWithClientMessageIds(entries, knownSkillNames(this.composerCommands(thread)));
    let messageIndex = 0;
    return entries.flatMap((entry) => {
      const typed = entry as { type?: unknown; id?: unknown };
      if (typed.type !== "message") return [];
      const rawMessage = (entry as { message?: unknown }).message;
      const projected = messages[messageIndex++] as Record<string, unknown>;
      const mapped = mapMessage({ ...projected, tauEntryId: typed.id }, messageIndex - 1, this.mapping(thread));
      const raw = rawMessage && typeof rawMessage === "object" ? rawMessage : undefined;
      const identity = mapped?.role === "user"
        ? resolveClientTurnIdentity(
          mapped,
          raw ? this.clientTurns.identityForRaw(raw) ?? this.clientTurns.identityForMessage(thread.threadId, mapped) : undefined,
        )
        : undefined;
      if (identity && raw && mapped) this.clientTurns.remember(thread.threadId, mapped, identity, raw);
      return [{ ...projected, tauEntryId: typed.id, ...(identity ?? {}) }];
    });
  }

  messages(thread: ThreadRuntime): UiMessage[] {
    if (!isPiBackend(thread)) return [...thread.adapterMessages];
    const mapping = this.mapping(thread);
    const messages = this.branchMessages(thread)
      .map((message, index) => mapMessage(message, index, mapping))
      .filter((message): message is UiMessage => isVisibleMessage(message, mapping.pinned));
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

  pinnedEntries(thread: ThreadRuntime): ReadonlySet<string> {
    if (this.entryPinProviders.size === 0 || !isPiBackend(thread)) return EMPTY_PINS;
    const entries = thread.backend.branchEntries();
    const leaf = entries.at(-1);
    const cached = this.pinnedCache.get(thread);
    if (cached && cached.size === entries.length && cached.leaf === leaf) return cached.pinned;
    const pinned = new Set<string>();
    for (const provider of this.entryPinProviders) {
      try { for (const id of provider(this.hostThread(thread))) pinned.add(id); }
      catch (error) { this.reportPinFailure(error); }
    }
    this.pinnedCache.set(thread, { size: entries.length, leaf, pinned });
    return pinned;
  }

  hostSnapshot(thread: ThreadRuntime | undefined, models: UiModel[], cwd: string, extensionCount: number): HostSnapshot {
    const attached = this.attachedSnapshot();
    if (attached) return { ...this.attachedHostSnapshot(), models };
    if (!thread) throw new Error("Pi runtime is not ready");
    const messages = this.messages(thread);
    const firstUserMessage = messages.find((message) => message.role === "user");
    if (!isPiBackend(thread)) return {
      cwd: thread.cwd,
      threadId: thread.threadId,
      providerSessionId: thread.backend.providerSessionId,
      sessionId: thread.threadId,
      sessionName: safeSessionTitle(thread.adapterTitle),
      sessionTitle: cleanThreadTitle(safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
      runtimeCapabilities: thread.runtimeAdapter.capabilities,
      backendKind: thread.backend.kind,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      messages,
      isStreaming: thread.adapterStreaming || thread.backend.isStreaming(),
      activeTools: [],
      taskProgress: undefined,
      taskHistory: [],
      allTools: [],
      composerCommands: this.composerCommands(thread),
      extensionCount: 0,
    };
    const branchMessages = this.branchMessages(thread);
    const usage = thread.backend.contextUsage();
    return {
      cwd,
      threadId: thread.threadId,
      providerSessionId: thread.backend.providerSessionId,
      sessionId: thread.threadId,
      sessionName: safeSessionTitle(thread.backend.sessionName()),
      sessionTitle: cleanThreadTitle(safeSessionTitle(thread.backend.sessionName()) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
      model: thread.backend.model(),
      runtimeCapabilities: thread.runtimeAdapter.capabilities,
      backendKind: thread.backend.kind,
      models,
      thinkingLevel: thread.backend.thinkingLevel(),
      thinkingLevels: thread.backend.thinkingLevels(),
      messages,
      isStreaming: thread.backend.isStreaming() || thread.adapterStreaming,
      activeTools: thread.backend.activeToolNames(),
      turnActivity: this.turnActivity(thread, branchMessages),
      turnActivityHistory: turnActivityHistoryFromMessages(branchMessages),
      taskProgress: taskProgressFromMessages(branchMessages),
      taskHistory: taskProgressHistoryFromMessages(branchMessages),
      allTools: thread.backend.allTools(),
      composerCommands: this.composerCommands(thread),
      extensionCount,
      historyCompleteness: "complete",
      supportsImageInput: modelSupportsImageInput(thread.runtime?.session.model),
      contextUsage: usage && usage.tokens !== null && usage.percent !== null
        ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
        : undefined,
    };
  }
}
