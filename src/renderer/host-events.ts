import type { Dispatch, SetStateAction } from "react";
import type { ExtensionUiPrompt, HostEvent, HostSnapshot, UiMessage, UiToolRun } from "../shared/contracts";
import type { HostUpdate } from "../shared/host-protocol";
import type { TranscriptMessageIndex, TranscriptMessageUpdate } from "../shared/transcript-index";
import type { TranscriptTurnStart } from "./components/transcript-navigation";
import type { ExtensionRegistry } from "./extension-system";
import { isSameUserMessage, reconcileOptimisticMessages, type NewThreadSubmissionRecovery, type OptimisticUserMessage } from "./app-state";
import { preferences } from "./preferences";
import type { ThreadStore } from "./thread-store";

interface RefLike<T> { current: T }

export interface HostEventStores {
  registry: ExtensionRegistry;
  threadStore: ThreadStore;
  detailStore: import("../shared/thread-detail-store").ThreadDetailStore;
  messages: RefLike<UiMessage[]>;
  transcriptTurnStart: RefLike<TranscriptTurnStart | undefined>;
  recoveries: RefLike<Map<string, NewThreadSubmissionRecovery>>;
  activeDraftKey: RefLike<string | undefined>;
  assistantStarts: RefLike<Map<string, number>>;
  pendingToolUpdates: RefLike<Map<string, string>>;
  toolFrame: RefLike<number | undefined>;
  toolAnchor: RefLike<string | undefined>;
  runningThread: RefLike<string>;
  assistantAnchors: RefLike<Map<string, { id: string; timestamp: number; beforeMessageId?: string }>>;
  transcriptIndex: RefLike<TranscriptMessageIndex>;
  setOptimisticMessages: Dispatch<SetStateAction<OptimisticUserMessage[]>>;
  setTranscriptTurnStart(value: TranscriptTurnStart | undefined, expectedTurnId?: string): void;
  setNotice(message?: string, level?: "info" | "warning" | "error"): void;
  settleNewThreadDelivery(clientMessageId: string, sessionId: string, settlement: { accepted: true } | { accepted: false; message: string }): boolean;
  promoteRecoveryToSession(clientMessageId: string, sessionId: string, message: UiMessage): boolean;
  applyHostUpdate(update: HostUpdate): void;
  applyThreadIndex(index: import("../shared/contracts").ThreadIndexSnapshot): void;
  flushAssistantDeltas(): void;
  flushToolUpdates(): void;
  updateTools(update: UiToolRun[] | ((current: UiToolRun[]) => UiToolRun[])): void;
  setToolAnchorId: Dispatch<SetStateAction<string | undefined>>;
  setTurnActivitySessionId: Dispatch<SetStateAction<string | undefined>>;
  setSnapshot: Dispatch<SetStateAction<HostSnapshot | undefined>>;
  setRunStartedAt: Dispatch<SetStateAction<number | undefined>>;
  appendTranscriptMessage(message: UiMessage): void;
  queueAssistantDelta(id: string, kind: "text" | "thinking", delta: string): void;
  replaceTranscriptMessages(messages: readonly UiMessage[]): void;
  updateTranscriptMessages(updates: ReadonlyMap<string, TranscriptMessageUpdate>): void;
  setMessages: Dispatch<SetStateAction<UiMessage[]>>;
  queueToolUpdate(id: string, output: string): void;
  addEvent(label: string, detail?: string, timestamp?: number): void;
  setUiPrompts: Dispatch<SetStateAction<ExtensionUiPrompt[]>>;
  setQueue: Dispatch<SetStateAction<string[]>>;
}

/** Applies one host event to renderer-owned stores and transient view state. */
export function applyHostEvent(event: HostEvent, stores: HostEventStores): void {
  const { registry, threadStore } = stores;
  if (event.type === "tool-start" || event.type === "tool-end" || event.type === "agent-status"
    || event.type === "user-message" || event.type === "assistant-end" || event.type === "thread-index" || event.type === "notice") {
    queueMicrotask(() => registry.dispatchWorkbenchEvent(event));
  }
  if (event.type === "user-message") {
    const clientMessageId = event.message.clientMessageId;
    if (clientMessageId && stores.recoveries.current.has(clientMessageId)) {
      stores.promoteRecoveryToSession(clientMessageId, event.sessionId, event.message);
    }
    const active = event.sessionId === threadStore.getSnapshot().activeThreadId;
    const known = active ? stores.messages.current : stores.detailStore.get(event.sessionId)?.messages;
    if (known && !known.some((message) => isSameUserMessage(message, event.message))) preferences.unsettle(event.sessionId);
  }
  if (event.type === "prompt-without-user-turn") {
    stores.setOptimisticMessages((current) => current.filter((entry) => entry.message.clientMessageId !== event.clientMessageId));
    const turnStart = stores.transcriptTurnStart.current;
    if (turnStart?.clientMessageId === event.clientMessageId) stores.setTranscriptTurnStart(undefined, turnStart.turnId);
    const recovery = stores.recoveries.current.get(event.clientMessageId);
    if (recovery) recovery.withoutUserTurn = true;
    return;
  }
  if (event.type === "new-thread-delivery-settled") {
    stores.settleNewThreadDelivery(event.clientMessageId, event.sessionId, event.accepted
      ? { accepted: true }
      : { accepted: false, message: event.message });
  }
  if (event.type === "user-message-failed") {
    stores.setOptimisticMessages((current) => current.filter((entry) => entry.message.clientMessageId !== event.clientMessageId));
    const recovery = stores.recoveries.current.get(event.clientMessageId);
    if (recovery) stores.settleNewThreadDelivery(event.clientMessageId, event.sessionId, { accepted: false, message: event.message });
    if (event.sessionId === threadStore.getSnapshot().activeThreadId
      || recovery?.scopeRef.scope === stores.activeDraftKey.current) stores.setNotice(event.message);
    return;
  }
  if ((event.type === "assistant-start" || event.type === "assistant-delta" || event.type === "assistant-thinking"
    || event.type === "assistant-end" || event.type === "assistant-anchor" || event.type === "user-message"
    || event.type === "tool-start" || event.type === "tool-update" || event.type === "tool-end" || event.type === "queue")
    && event.sessionId !== threadStore.getSnapshot().activeThreadId) return;

  switch (event.type) {
    case "host-update": stores.applyHostUpdate(event.update); break;
    case "thread-index": stores.applyThreadIndex(event.threadIndex); break;
    case "extension-event": registry.dispatchExtensionEvent(event); break;
    case "agent-status": applyAgentStatus(event, stores); break;
    case "assistant-start":
      stores.assistantStarts.current.set(event.id, event.timestamp);
      break;
    case "assistant-delta":
    case "assistant-thinking": {
      if (!stores.transcriptIndex.current.has(event.id)) stores.appendTranscriptMessage({
        id: event.id,
        role: "assistant",
        text: "",
        timestamp: stores.assistantStarts.current.get(event.id) ?? Date.now(),
      });
      stores.queueAssistantDelta(event.id, event.type === "assistant-delta" ? "text" : "thinking", event.delta);
      break;
    }
    case "assistant-end":
      stores.flushAssistantDeltas();
      stores.assistantStarts.current.delete(event.message.id);
      if (!event.message.text) {
        stores.transcriptIndex.current.remove(event.message.id);
        stores.replaceTranscriptMessages(stores.transcriptIndex.current.messages);
      } else if (stores.transcriptIndex.current.has(event.message.id)) {
        stores.updateTranscriptMessages(new Map([[event.message.id, () => event.message]]));
      } else stores.appendTranscriptMessage(event.message);
      break;
    case "assistant-anchor":
      applyAssistantAnchor(event, stores);
      break;
    case "user-message":
      if (stores.transcriptIndex.current.has(event.message.id)) {
        stores.updateTranscriptMessages(new Map([[event.message.id, () => event.message]]));
      } else stores.appendTranscriptMessage(event.message);
      stores.setOptimisticMessages((current) => reconcileOptimisticMessages(current, [event.message]));
      break;
    case "tool-start": {
      threadStore.toolStarted(event.tool.id, event.tool.name);
      if (!stores.toolAnchor.current) {
        const anchor = [...stores.messages.current].reverse().find((message) => message.text.trim())?.id;
        stores.toolAnchor.current = anchor;
        stores.setToolAnchorId(anchor);
      }
      stores.updateTools((current) => [...current.filter((tool) => tool.id !== event.tool.id), event.tool]);
      break;
    }
    case "tool-update":
      stores.queueToolUpdate(event.id, event.output);
      break;
    case "tool-end":
      stores.pendingToolUpdates.current.delete(event.tool.id);
      threadStore.toolEnded(event.tool.id);
      stores.updateTools((current) => current.map((tool) => tool.id === event.tool.id ? event.tool : tool));
      break;
    case "event-log":
      if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) {
        stores.addEvent(event.label, event.detail, event.timestamp);
      }
      break;
    case "error":
      if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) stores.setNotice(event.message);
      break;
    case "extension-ui-prompt": {
      const known = registry.interceptPrompt(event.prompt);
      if (known) void window.tau?.answerExtensionUi(event.prompt.id, known);
      else stores.setUiPrompts((current) => [...current, event.prompt]);
      break;
    }
    case "extension-ui-resolved":
      if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) {
        stores.setUiPrompts((current) => current.filter((entry) => entry.id !== event.id));
      }
      break;
    case "notice":
      if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) stores.setNotice(event.message, event.level);
      break;
    case "queue":
      stores.setQueue([...event.steering, ...event.followUp]);
      stores.addEvent("queue.changed", `${event.steering.length} steering · ${event.followUp.length} follow-up`);
      break;
  }
}

function applyAgentStatus(event: Extract<HostEvent, { type: "agent-status" }>, stores: HostEventStores): void {
  const { threadStore } = stores;
  threadStore.setThreadRunning(event.sessionId, event.running);
  if (event.sessionId !== threadStore.getSnapshot().activeThreadId) return;
  if (event.running) {
    stores.pendingToolUpdates.current.clear();
    if (stores.toolFrame.current !== undefined) cancelAnimationFrame(stores.toolFrame.current);
    stores.toolFrame.current = undefined;
    stores.updateTools([]);
    stores.toolAnchor.current = undefined;
    stores.setToolAnchorId(undefined);
    stores.setTurnActivitySessionId(event.sessionId);
  }
  threadStore.setStreaming(event.running);
  stores.setSnapshot((current) => {
    if (event.running && current) stores.runningThread.current = current.sessionId;
    return current ? { ...current, isStreaming: event.running } : current;
  });
  stores.setRunStartedAt(event.running ? Date.now() : undefined);
  if (!event.running) {
    stores.flushToolUpdates();
    const finished = stores.runningThread.current;
    const viewed = threadStore.getSnapshot().activeThreadId;
    if (finished && (finished !== viewed || document.hidden)) threadStore.markUnread(finished);
    stores.runningThread.current = "";
  }
}

function applyAssistantAnchor(event: Extract<HostEvent, { type: "assistant-anchor" }>, stores: HostEventStores): void {
  stores.assistantAnchors.current.set(event.sourceEntryId, {
    id: event.id,
    timestamp: event.timestamp,
    ...(event.beforeMessageId ? { beforeMessageId: event.beforeMessageId } : {}),
  });
  stores.setMessages((current) => {
    const existing = current.find((message) => message.id === event.id || message.sourceEntryId === event.sourceEntryId);
    if (!existing) return current;
    stores.assistantAnchors.current.delete(event.sourceEntryId);
    const next = current.map((message) => message.id === event.id || message.sourceEntryId === event.sourceEntryId
      ? { ...message, sourceEntryId: event.sourceEntryId }
      : message);
    stores.messages.current = next;
    return next;
  });
}
