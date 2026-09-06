import type {
  ExtensionUiPrompt,
  HostEvent,
  HostSnapshot,
  UiMessage,
  UiToolRun,
  UiTurnActivityEntry,
} from "../shared/contracts";
import { ThreadDetailStore } from "../shared/thread-detail-store";
import { conversationMessagesFor, isSameUserMessage, reconcileOptimisticMessages, type OptimisticUserMessage } from "./app-state";
import {
  appendMessage,
  appendMessageDelta,
  EMPTY_TRANSCRIPT,
  hasMessage,
  removeMessage,
  replaceMessage,
  replaceTranscript,
  updateMessage,
  type TranscriptState,
} from "./transcript-state";

/** One line of the workbench's own log: what happened, when, and a detail. */
export interface TimelineEvent {
  id: string;
  label: string;
  detail?: string;
  timestamp: number;
}

export type NoticeLevel = "info" | "warning" | "error";

export interface ThreadViewNotice {
  message: string;
  level: NoticeLevel;
}

/** A live assistant row waiting for the extension row that asks for its entry. */
export interface AssistantAnchorRecord {
  id: string;
  timestamp: number;
  beforeMessageId?: string;
}

/** Everything the workbench shows about the one thread on screen. */
export interface ThreadViewState {
  /** The thread this view belongs to; every runtime event is filtered against it. */
  readonly activeThreadId: string;
  /** The thread whose run started while it was visible; unread marking needs it at the end. */
  readonly runningThreadId: string;
  readonly snapshot?: HostSnapshot;
  readonly transcript: TranscriptState;
  readonly optimisticMessages: readonly OptimisticUserMessage[];
  readonly tools: readonly UiToolRun[];
  readonly toolAnchorId?: string;
  readonly turnActivityHistory: readonly UiTurnActivityEntry[];
  readonly turnActivitySessionId?: string;
  readonly uiPrompts: readonly ExtensionUiPrompt[];
  readonly assistantStarts: ReadonlyMap<string, number>;
  readonly assistantAnchors: ReadonlyMap<string, AssistantAnchorRecord>;
  readonly events: readonly TimelineEvent[];
  readonly eventSequence: number;
  readonly notice?: ThreadViewNotice;
}

/**
 * What the workbench needs to know about the conversation without reading its
 * rows: whether anything is on screen, and where live activity anchors.
 */
export interface ConversationSummary {
  readonly isEmpty: boolean;
  readonly lastMessageId?: string;
}

const EMPTY_CONVERSATION: ConversationSummary = { isEmpty: true };

function conversationSummary(
  state: ThreadViewState,
  activeDraftKey: string | undefined,
  pendingNewThread: boolean,
): ConversationSummary {
  const messages = state.transcript.messages;
  // The common case has nothing unconfirmed, so a streamed delta costs one
  // filter over an empty list and a look at the last row.
  if (!state.optimisticMessages.some((entry) => entry.scope === activeDraftKey)) {
    if (pendingNewThread || messages.length === 0) return EMPTY_CONVERSATION;
    return { isEmpty: false, lastMessageId: messages[messages.length - 1].id };
  }
  const conversation = conversationMessagesFor(messages, state.optimisticMessages, activeDraftKey, pendingNewThread);
  return conversation.length === 0
    ? EMPTY_CONVERSATION
    : { isEmpty: false, lastMessageId: conversation[conversation.length - 1].id };
}

export interface ToolViewState {
  tools: readonly UiToolRun[];
  toolAnchorId?: string;
  turnActivityHistory: readonly UiTurnActivityEntry[];
  turnActivitySessionId?: string;
}

const EMPTY_TOOL_VIEW: ToolViewState = { tools: [], turnActivityHistory: [] };

export function createThreadViewState(snapshot?: HostSnapshot): ThreadViewState {
  return {
    activeThreadId: snapshot?.sessionId ?? "",
    runningThreadId: "",
    snapshot,
    transcript: snapshot ? replaceTranscript(EMPTY_TRANSCRIPT, snapshot.messages) : EMPTY_TRANSCRIPT,
    optimisticMessages: [],
    tools: [],
    turnActivityHistory: snapshot?.turnActivityHistory ?? [],
    uiPrompts: [],
    assistantStarts: new Map(),
    assistantAnchors: new Map(),
    events: [],
    eventSequence: 0,
  };
}

/** Live events belong to one runtime; only the visible thread projects them. */
function isBackgroundEvent(state: ThreadViewState, event: HostEvent): boolean {
  switch (event.type) {
    case "assistant-start":
    case "assistant-delta":
    case "assistant-thinking":
    case "assistant-end":
    case "assistant-anchor":
    case "user-message":
    case "tool-start":
    case "tool-update":
    case "tool-end":
    case "queue":
      return event.sessionId !== state.activeThreadId;
    case "agent-status":
    case "extension-ui-resolved":
    case "error":
    case "notice":
    case "event-log":
      return Boolean(event.sessionId) && event.sessionId !== state.activeThreadId;
    default:
      return false;
  }
}

function withEvent(state: ThreadViewState, label: string, detail?: string, timestamp = Date.now()): ThreadViewState {
  const entry: TimelineEvent = { id: `${timestamp}-${state.eventSequence}`, label, detail, timestamp };
  return { ...state, events: [...state.events.slice(-99), entry], eventSequence: state.eventSequence + 1 };
}

function withNotice(state: ThreadViewState, message?: string, level: NoticeLevel = "info"): ThreadViewState {
  if (message === undefined) return state.notice === undefined ? state : { ...state, notice: undefined };
  return { ...state, notice: { message, level } };
}

function withoutOptimistic(state: ThreadViewState, clientMessageId: string): ThreadViewState {
  const next = state.optimisticMessages.filter((entry) => entry.message.clientMessageId !== clientMessageId);
  return next.length === state.optimisticMessages.length ? state : { ...state, optimisticMessages: next };
}

function reconciled(
  current: readonly OptimisticUserMessage[],
  authoritative: readonly UiMessage[],
): readonly OptimisticUserMessage[] {
  const next = reconcileOptimisticMessages(current, authoritative);
  return next.length === current.length ? current : next;
}

function withoutMapEntry<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/**
 * The whole HostEvent union as one transition of the visible thread. Effects
 * that are not view state — host updates, the thread index, extension routing,
 * new-thread delivery — stay in `applyHostEvent`.
 */
export function reduceHostEvent(state: ThreadViewState, event: HostEvent): ThreadViewState {
  if (isBackgroundEvent(state, event)) return state;
  switch (event.type) {
    case "host-update":
    case "thread-index":
    case "extension-event":
    case "app-update":
    case "new-thread-delivery-settled":
      return state;
    case "prompt-without-user-turn":
      return withoutOptimistic(state, event.clientMessageId);
    case "user-message-failed":
      return withoutOptimistic(state, event.clientMessageId);
    case "agent-status":
      // A starting run opens a fresh activity group; a stopping one keeps the
      // finished tools on screen until the next turn replaces them.
      return event.running
        ? {
          ...state,
          tools: [],
          toolAnchorId: undefined,
          turnActivitySessionId: event.sessionId,
          runningThreadId: state.snapshot?.sessionId ?? "",
        }
        : state.runningThreadId ? { ...state, runningThreadId: "" } : state;
    case "assistant-start":
      return { ...state, assistantStarts: new Map(state.assistantStarts).set(event.id, event.timestamp) };
    case "assistant-delta":
    case "assistant-thinking": {
      const kind = event.type === "assistant-delta" ? "text" : "thinking";
      const withRow = hasMessage(state.transcript, event.id) ? state.transcript : appendMessage(state.transcript, {
        id: event.id,
        role: "assistant",
        text: "",
        timestamp: state.assistantStarts.get(event.id) ?? Date.now(),
      });
      const transcript = appendMessageDelta(withRow, event.id, kind, event.delta);
      return transcript === state.transcript ? state : { ...state, transcript };
    }
    case "assistant-end": {
      const { message } = event;
      const transcript = !message.text
        ? removeMessage(state.transcript, message.id)
        : hasMessage(state.transcript, message.id)
          ? replaceMessage(state.transcript, message.id, message)
          : appendMessage(state.transcript, message);
      return { ...state, transcript, assistantStarts: withoutMapEntry(state.assistantStarts, message.id) };
    }
    case "assistant-anchor": {
      const matches = (message: UiMessage) => message.id === event.id || message.sourceEntryId === event.sourceEntryId;
      if (!state.transcript.messages.some(matches)) {
        return {
          ...state,
          assistantAnchors: new Map(state.assistantAnchors).set(event.sourceEntryId, {
            id: event.id,
            timestamp: event.timestamp,
            ...(event.beforeMessageId ? { beforeMessageId: event.beforeMessageId } : {}),
          }),
        };
      }
      const anchored = state.transcript.messages.filter(matches).map((message) => message.id);
      let transcript = state.transcript;
      for (const id of anchored) {
        transcript = updateMessage(transcript, id, (message) => ({ ...message, sourceEntryId: event.sourceEntryId }));
      }
      return {
        ...state,
        transcript,
        assistantAnchors: withoutMapEntry(state.assistantAnchors, event.sourceEntryId),
      };
    }
    case "user-message": {
      // A thread-detail update can win the race against this live event. Its
      // persisted row has a different entry id, so deduplicate by the client
      // identity rather than by id alone.
      const existing = state.transcript.messages.find((message) => isSameUserMessage(message, event.message));
      const transcript = !existing
        ? appendMessage(state.transcript, event.message)
        : existing.id === event.message.id
          ? replaceMessage(state.transcript, event.message.id, event.message)
          : state.transcript;
      return { ...state, transcript, optimisticMessages: reconciled(state.optimisticMessages, [event.message]) };
    }
    case "tool-start": {
      const toolAnchorId = state.toolAnchorId
        ?? [...state.transcript.messages].reverse().find((message) => message.text.trim())?.id;
      return {
        ...state,
        toolAnchorId,
        tools: [...state.tools.filter((tool) => tool.id !== event.tool.id), event.tool],
      };
    }
    case "tool-update": {
      const tools = state.tools.map((tool) => tool.id === event.id && tool.output !== event.output
        ? { ...tool, output: event.output }
        : tool);
      return tools.every((tool, index) => tool === state.tools[index]) ? state : { ...state, tools };
    }
    case "tool-end":
      return { ...state, tools: state.tools.map((tool) => tool.id === event.tool.id ? event.tool : tool) };
    case "event-log":
      return withEvent(state, event.label, event.detail, event.timestamp);
    case "error":
      return withNotice(state, event.message);
    case "notice":
      return withNotice(state, event.message, event.level);
    case "extension-ui-prompt":
      return { ...state, uiPrompts: [...state.uiPrompts, event.prompt] };
    case "extension-ui-resolved": {
      const uiPrompts = state.uiPrompts.filter((entry) => entry.id !== event.id);
      return uiPrompts.length === state.uiPrompts.length ? state : { ...state, uiPrompts };
    }
    case "queue":
      // Follow-ups wait in the workbench queue; this only mirrors the runtime's
      // own steering queue into the event log.
      return withEvent(state, "queue.changed", `${event.steering.length} steering · ${event.followUp.length} follow-up`);
    // The extension registries live outside this view; `applyHostEvent` routes
    // these two before the thread reducer ever sees them.
    case "extension-packages-changed":
    case "extension-deactivated":
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

type Updater<T> = T | ((current: T) => T);

function resolve<T>(update: Updater<T>, current: T): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

/**
 * Single source of truth for the active thread. Consumers subscribe per slice,
 * so a streamed delta wakes the transcript and nothing else. Streaming deltas
 * and tool output are merged per animation frame before they reach the reducer.
 */
export class ThreadViewStore {
  /** The one in-memory detail cache; the history controller shares it. */
  readonly details = new ThreadDetailStore(5);

  private state: ThreadViewState;
  private toolView: ToolViewState = EMPTY_TOOL_VIEW;
  private readonly snapshotListeners = new Set<() => void>();
  private readonly transcriptListeners = new Set<() => void>();
  private readonly toolListeners = new Set<() => void>();
  private readonly promptListeners = new Set<() => void>();
  private readonly optimisticListeners = new Set<() => void>();
  private readonly noticeListeners = new Set<() => void>();
  private readonly eventListeners = new Set<() => void>();
  private readonly conversationListeners = new Set<() => void>();
  private readonly userMessageListeners = new Set<() => void>();
  private conversationCache?: { key: string; summary: ConversationSummary };
  private pendingDeltas = new Map<string, { text: string; thinking: string }>();
  private pendingToolOutput = new Map<string, string>();
  private deltaFrame?: number;
  private toolFrame?: number;

  constructor(snapshot?: HostSnapshot) {
    this.state = createThreadViewState(snapshot);
    this.toolView = this.buildToolView();
  }

  getState = (): ThreadViewState => this.state;
  getSnapshot = (): HostSnapshot | undefined => this.state.snapshot;
  getTranscript = (): TranscriptState => this.state.transcript;
  getToolView = (): ToolViewState => this.toolView;
  getUiPrompts = (): readonly ExtensionUiPrompt[] => this.state.uiPrompts;
  getOptimisticMessages = (): readonly OptimisticUserMessage[] => this.state.optimisticMessages;
  getNotice = (): ThreadViewNotice | undefined => this.state.notice;
  getEvents = (): readonly TimelineEvent[] => this.state.events;
  /** Bumps only when a user message can change how optimistic rows reconcile. */
  getUserRevision = (): number => this.state.transcript.userRevision;

  /**
   * The conversation as two facts, cached by value: a consumer of this
   * selector re-renders when the summary changes, not when the rows do.
   */
  selectConversation = (activeDraftKey: string | undefined, pendingNewThread: boolean): ConversationSummary => {
    const key = `${pendingNewThread ? "draft" : "session"}\0${activeDraftKey ?? ""}`;
    const summary = conversationSummary(this.state, activeDraftKey, pendingNewThread);
    const cached = this.conversationCache;
    if (cached?.key === key
      && cached.summary.isEmpty === summary.isEmpty
      && cached.summary.lastMessageId === summary.lastMessageId) return cached.summary;
    this.conversationCache = { key, summary };
    return summary;
  };

  subscribeToSnapshot = (listener: () => void) => this.add(this.snapshotListeners, listener);
  subscribeToTranscript = (listener: () => void) => this.add(this.transcriptListeners, listener);
  subscribeToTools = (listener: () => void) => this.add(this.toolListeners, listener);
  subscribeToPrompts = (listener: () => void) => this.add(this.promptListeners, listener);
  subscribeToOptimistic = (listener: () => void) => this.add(this.optimisticListeners, listener);
  subscribeToNotice = (listener: () => void) => this.add(this.noticeListeners, listener);
  subscribeToEvents = (listener: () => void) => this.add(this.eventListeners, listener);
  subscribeToConversation = (listener: () => void) => this.add(this.conversationListeners, listener);
  subscribeToUserMessages = (listener: () => void) => this.add(this.userMessageListeners, listener);

  /** One host event, batching what streams and reducing everything else. */
  dispatch(event: HostEvent): void {
    if (event.type === "assistant-delta" || event.type === "assistant-thinking") {
      if (event.sessionId !== this.state.activeThreadId) return;
      // The row is created now so later events keep their transcript order;
      // only its text waits for the frame.
      if (!hasMessage(this.state.transcript, event.id)) this.commit(reduceHostEvent(this.state, { ...event, delta: "" }));
      const pending = this.pendingDeltas.get(event.id) ?? { text: "", thinking: "" };
      pending[event.type === "assistant-delta" ? "text" : "thinking"] += event.delta;
      this.pendingDeltas.set(event.id, pending);
      if (this.deltaFrame === undefined) this.deltaFrame = requestAnimationFrame(() => this.flushAssistantDeltas());
      return;
    }
    if (event.type === "tool-update") {
      if (event.sessionId !== this.state.activeThreadId) return;
      this.pendingToolOutput.set(event.id, event.output);
      if (this.toolFrame === undefined) this.toolFrame = requestAnimationFrame(() => this.flushToolOutput());
      return;
    }
    if (event.type === "assistant-end") this.flushAssistantDeltas();
    if (event.type === "tool-end") this.pendingToolOutput.delete(event.tool.id);
    if (event.type === "agent-status" && event.sessionId === this.state.activeThreadId) {
      if (event.running) this.clearPendingToolOutput();
      else this.flushToolOutput();
    }
    this.commit(reduceHostEvent(this.state, event));
  }

  flushAssistantDeltas(): void {
    if (this.deltaFrame !== undefined) cancelAnimationFrame(this.deltaFrame);
    this.deltaFrame = undefined;
    if (this.pendingDeltas.size === 0) return;
    const pending = this.pendingDeltas;
    this.pendingDeltas = new Map();
    const sessionId = this.state.activeThreadId;
    let next = this.state;
    for (const [id, delta] of pending) {
      if (delta.text) next = reduceHostEvent(next, { type: "assistant-delta", sessionId, id, delta: delta.text });
      if (delta.thinking) next = reduceHostEvent(next, { type: "assistant-thinking", sessionId, id, delta: delta.thinking });
    }
    this.commit(next);
  }

  flushToolOutput(): void {
    if (this.toolFrame !== undefined) cancelAnimationFrame(this.toolFrame);
    this.toolFrame = undefined;
    if (this.pendingToolOutput.size === 0) return;
    const pending = this.pendingToolOutput;
    this.pendingToolOutput = new Map();
    const sessionId = this.state.activeThreadId;
    let next = this.state;
    for (const [id, output] of pending) next = reduceHostEvent(next, { type: "tool-update", sessionId, id, output });
    this.commit(next);
  }

  /** Point the view at a thread and drop everything the previous one had in flight. */
  beginThread(sessionId: string): void {
    this.clearPendingToolOutput();
    if (this.deltaFrame !== undefined) cancelAnimationFrame(this.deltaFrame);
    this.deltaFrame = undefined;
    this.pendingDeltas = new Map();
    this.commit({
      ...this.state,
      activeThreadId: sessionId,
      assistantStarts: new Map(),
      assistantAnchors: new Map(),
    });
  }

  setSnapshot(update: Updater<HostSnapshot | undefined>): void {
    const snapshot = resolve(update, this.state.snapshot);
    if (snapshot === this.state.snapshot) return;
    this.commit({
      ...this.state,
      snapshot,
      ...(snapshot ? { activeThreadId: snapshot.sessionId } : {}),
    });
  }

  setMessages(messages: readonly UiMessage[]): void {
    this.commit({ ...this.state, transcript: replaceTranscript(this.state.transcript, messages) });
  }

  setOptimisticMessages(update: Updater<readonly OptimisticUserMessage[]>): void {
    const optimisticMessages = resolve(update, this.state.optimisticMessages);
    if (optimisticMessages === this.state.optimisticMessages) return;
    this.commit({ ...this.state, optimisticMessages });
  }

  setTools(update: Updater<readonly UiToolRun[]>): void {
    const tools = resolve(update, this.state.tools);
    if (tools === this.state.tools) return;
    this.commit({ ...this.state, tools });
  }

  setToolAnchorId(toolAnchorId?: string): void {
    if (toolAnchorId === this.state.toolAnchorId) return;
    this.commit({ ...this.state, toolAnchorId });
  }

  setTurnActivity(turnActivityHistory: readonly UiTurnActivityEntry[], turnActivitySessionId?: string): void {
    this.commit({ ...this.state, turnActivityHistory, turnActivitySessionId });
  }

  setTurnActivityHistory(turnActivityHistory: readonly UiTurnActivityEntry[]): void {
    this.commit({ ...this.state, turnActivityHistory });
  }

  appendMessage(message: UiMessage): void {
    this.commit({ ...this.state, transcript: appendMessage(this.state.transcript, message) });
  }

  setUiPrompts(update: Updater<readonly ExtensionUiPrompt[]>): void {
    const uiPrompts = resolve(update, this.state.uiPrompts);
    if (uiPrompts === this.state.uiPrompts) return;
    this.commit({ ...this.state, uiPrompts });
  }

  setNotice = (message?: string, level: NoticeLevel = "info"): void => {
    this.commit(withNotice(this.state, message, level));
  };

  addEvent = (label: string, detail?: string, timestamp = Date.now()): void => {
    this.commit(withEvent(this.state, label, detail, timestamp));
  };

  /**
   * Materializes the parked anchor rows an extension asked for. An empty
   * assistant row only becomes visible once something wants to sit at it.
   */
  resolvePendingAnchors(sourceEntryIds: readonly string[]): void {
    const anchors = this.state.assistantAnchors;
    if (anchors.size === 0) return;
    const wanted = [...new Set(sourceEntryIds)].filter((id) => anchors.has(id));
    if (wanted.length === 0) return;
    const remaining = new Map(anchors);
    let messages = this.state.transcript.messages;
    for (const sourceEntryId of wanted) {
      const anchor = remaining.get(sourceEntryId)!;
      remaining.delete(sourceEntryId);
      if (messages.some((message) => message.sourceEntryId === sourceEntryId || message.id === anchor.id)) continue;
      const marker: UiMessage = { id: anchor.id, sourceEntryId, role: "assistant", text: "", timestamp: anchor.timestamp };
      const beforeIndex = anchor.beforeMessageId === undefined
        ? -1
        : messages.findIndex((message) => message.id === anchor.beforeMessageId || message.sourceEntryId === anchor.beforeMessageId);
      messages = beforeIndex < 0
        ? [...messages, marker]
        : [...messages.slice(0, beforeIndex), marker, ...messages.slice(beforeIndex)];
    }
    this.commit({
      ...this.state,
      assistantAnchors: remaining,
      ...(messages === this.state.transcript.messages
        ? {}
        : { transcript: replaceTranscript(this.state.transcript, messages) }),
    });
  }

  private clearPendingToolOutput(): void {
    if (this.toolFrame !== undefined) cancelAnimationFrame(this.toolFrame);
    this.toolFrame = undefined;
    this.pendingToolOutput = new Map();
  }

  private add(listeners: Set<() => void>, listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  private buildToolView(): ToolViewState {
    return {
      tools: this.state.tools,
      toolAnchorId: this.state.toolAnchorId,
      turnActivityHistory: this.state.turnActivityHistory,
      turnActivitySessionId: this.state.turnActivitySessionId,
    };
  }

  private commit(next: ThreadViewState): void {
    const previous = this.state;
    if (next === previous) return;
    this.state = next;
    if (next.snapshot !== previous.snapshot) this.snapshotListeners.forEach((listener) => listener());
    if (next.transcript !== previous.transcript) this.transcriptListeners.forEach((listener) => listener());
    if (next.tools !== previous.tools
      || next.toolAnchorId !== previous.toolAnchorId
      || next.turnActivityHistory !== previous.turnActivityHistory
      || next.turnActivitySessionId !== previous.turnActivitySessionId) {
      this.toolView = this.buildToolView();
      this.toolListeners.forEach((listener) => listener());
    }
    if (next.uiPrompts !== previous.uiPrompts) this.promptListeners.forEach((listener) => listener());
    if (next.optimisticMessages !== previous.optimisticMessages) this.optimisticListeners.forEach((listener) => listener());
    if (next.transcript !== previous.transcript || next.optimisticMessages !== previous.optimisticMessages) {
      this.conversationListeners.forEach((listener) => listener());
    }
    if (next.transcript.userRevision !== previous.transcript.userRevision) {
      this.userMessageListeners.forEach((listener) => listener());
    }
    if (next.notice !== previous.notice) this.noticeListeners.forEach((listener) => listener());
    if (next.events !== previous.events) this.eventListeners.forEach((listener) => listener());
  }
}
