import type { HostEvent, HostSnapshot, UiMessage, UiToolRun } from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, type HostUpdate, type ThreadDetail } from "../shared/host-protocol.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import { withClientTurnIdentity } from "./client-turn-ledger.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import type { MessageMappingOptions } from "./host-messages.js";
import { assistantError, boundedToolOutput, mapMessage, nextVisibleMessageId, resultText } from "./host-messages.js";
import { assistantAnchorForBranch } from "./session-entries.js";
import { isThreadRuntime, ThreadRuntime } from "./thread-runtime.js";
import type { LiveTurnState } from "./live-turn-state.js";

export interface SessionEventServices {
  clientTurns: ClientTurnLedger;
  emit(event: HostEvent): void;
  emitUpdate(update: HostUpdate): void;
  log(label: string, detail?: string): void;
  fail(error: unknown, sessionId: string): void;
  settledSnapshot(): Promise<HostSnapshot>;
  detailForSnapshot(snapshot: HostSnapshot): ThreadDetail;
  trackedClientMessageIds(thread: ThreadRuntime): string[];
  failClientMessageIfUnpersisted(thread: ThreadRuntime, clientMessageId: string, sessionId: string): void;
  correlateUserMessageStart(thread: ThreadRuntime | undefined, message: unknown, sessionId: string): void;
  decorateUserEvent(thread: ThreadRuntime, message: unknown): unknown;
  messageMappingOptions(thread: LiveTurnState): MessageMappingOptions;
  pinnedEntries(thread: ThreadRuntime): ReadonlySet<string>;
  ownTool(toolCallId: string, sessionId: string): void;
  releaseTool(toolCallId: string): void;
  pushToolOutput(toolCallId: string, output: string): void;
  toolEnded(sessionId: string, tool: UiToolRun, cwd: string): void;
  /** How the run ended: the error its last answer stopped on, or undefined. */
  turnSettled(sessionId: string, error: string | undefined): void;
}

/** Translate runtime events into the common host event stream. */
export function handleRuntimeSessionEvent(
  event: any,
  thread: LiveTurnState,
  sessionId: string,
  cwd: string,
  services: SessionEventServices,
): void {
  if (thread instanceof ThreadRuntime && thread.deferEvent(event, sessionId, cwd)) return;
  const { emit, emitUpdate, log } = services;
  switch (event.type) {
    case "user_message_failed":
      if (typeof event.clientMessageId === "string") emit({
        type: "user-message-failed",
        sessionId,
        clientMessageId: event.clientMessageId,
        message: typeof event.message === "string" ? event.message : "Pi rejected the message.",
      });
      break;
    case "agent_start":
      thread.turnError = undefined;
      emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "started", sessionId });
      emit({ type: "agent-status", sessionId, running: true });
      log("agent.started", sessionId.slice(0, 8));
      break;
    case "agent_end":
      log("agent.ended", `${event.messages.length} messages`);
      break;
    case "agent_settled":
      settleRun(thread, sessionId, services);
      break;
    case "message_start":
      if (event.message.role === "user") {
        services.correlateUserMessageStart(isThreadRuntime(thread) ? thread : undefined, event.message, sessionId);
      } else if (event.message.role === "assistant") {
        thread.currentAssistantId = `assistant-live-${event.message.timestamp}`;
        thread.liveAssistant = { id: thread.currentAssistantId, text: "", thinking: "", timestamp: event.message.timestamp };
        emit({ type: "assistant-start", sessionId, id: thread.currentAssistantId, timestamp: event.message.timestamp });
      }
      break;
    case "message_update":
      updateAssistant(event, thread, sessionId, emit);
      break;
    case "message_end":
      finishMessage(event, thread, sessionId, services);
      break;
    case "tool_execution_start": {
      const tool: UiToolRun = {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args as Record<string, unknown>,
        status: "running",
        startedAt: Date.now(),
      };
      thread.tools.set(tool.id, tool);
      services.ownTool(tool.id, sessionId);
      emit({ type: "tool-start", sessionId, tool });
      log("tool.started", event.toolName);
      break;
    }
    case "tool_execution_update": {
      const output = boundedToolOutput(resultText(event.partialResult));
      const previous = thread.tools.get(event.toolCallId);
      if (previous) thread.tools.set(event.toolCallId, { ...previous, output });
      services.pushToolOutput(event.toolCallId, output);
      break;
    }
    case "tool_execution_end":
      finishTool(event, thread, sessionId, cwd, services);
      break;
    case "queue_update":
      emit({ type: "queue", sessionId, steering: [...event.steering], followUp: [...event.followUp] });
      break;
  }
}

function settleRun(thread: LiveTurnState, sessionId: string, services: SessionEventServices): void {
  if (isThreadRuntime(thread) && thread.state.idle
    && (thread.pendingClientMessageIds.length > 0 || thread.inFlightClientMessageIds.size > 0)) {
    for (const clientMessageId of services.trackedClientMessageIds(thread)) {
      services.failClientMessageIfUnpersisted(thread, clientMessageId, sessionId);
    }
    thread.pendingClientMessageIds.length = 0;
    thread.inFlightClientMessageIds.clear();
  }
  if (!isThreadRuntime(thread) || thread.state.idle) services.clientTurns.settle(sessionId);
  services.turnSettled(sessionId, thread.turnError);
  services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "settled", sessionId });
  services.emit({ type: "agent-status", sessionId, running: false });
  if (isThreadRuntime(thread)) {
    void services.settledSnapshot().then((snapshot) => {
      if (snapshot.sessionId !== sessionId || snapshot.isStreaming) return;
      services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: services.detailForSnapshot(snapshot) });
    }).catch((error) => services.fail(error, sessionId));
  }
  services.log("agent.settled", sessionId.slice(0, 8));
}

function updateAssistant(event: any, thread: LiveTurnState, sessionId: string, emit: (event: HostEvent) => void): void {
  const update = event.assistantMessageEvent;
  if (!thread.currentAssistantId) return;
  if (update.type === "text_delta") {
    if (thread.liveAssistant) thread.liveAssistant.text += update.delta;
    emit({ type: "assistant-delta", sessionId, id: thread.currentAssistantId, delta: update.delta });
  } else if (update.type === "thinking_delta") {
    if (thread.liveAssistant) thread.liveAssistant.thinking += update.delta;
    emit({ type: "assistant-thinking", sessionId, id: thread.currentAssistantId, delta: update.delta });
  }
}

function finishMessage(event: any, thread: LiveTurnState, sessionId: string, services: SessionEventServices): void {
  if (event.message.role === "assistant") {
    const message = mapMessage(event.message, 0, services.messageMappingOptions(thread));
    if (message) {
      message.id = thread.currentAssistantId ?? message.id;
      services.emit({ type: "assistant-end", sessionId, message });
      publishAssistantAnchor(event.message, message, thread, sessionId, services);
    }
    // The message carries the error into the transcript; the notice reaches a reader elsewhere.
    const error = assistantError(event.message);
    if (error) services.emit({ type: "notice", sessionId, level: "error", message: error });
    // A retry that answers after an error leaves the run a success.
    thread.turnError = error;
    thread.currentAssistantId = undefined;
    thread.liveAssistant = undefined;
    return;
  }
  if (event.message.role !== "user") return;
  const decorated = isThreadRuntime(thread) ? services.decorateUserEvent(thread, event.message) : event.message;
  const mapping = services.messageMappingOptions(thread);
  const message = mapMessage(decorated, 0, mapping);
  if (!message) return;
  const fingerprint = clientMessageFingerprint(event.message, knownSkillNames(mapping.skillCommands ?? []));
  const identity = services.clientTurns.identityForRaw(event.message)
    ?? services.clientTurns.claim(sessionId, { ...message, fingerprint }, event.message);
  if (identity && event.message && typeof event.message === "object") {
    const raw = event.message as Record<string, unknown>;
    raw.tauClientTurnId = identity.clientTurnId;
    raw.tauClientMessageId = identity.clientMessageId;
    raw.clientTurnId ??= identity.clientTurnId;
    raw.clientMessageId ??= identity.clientMessageId;
  }
  services.emit({ type: "user-message", sessionId, message: withClientTurnIdentity(message, identity) });
}

function publishAssistantAnchor(
  rawMessage: unknown,
  message: UiMessage,
  thread: LiveTurnState,
  sessionId: string,
  services: SessionEventServices,
): void {
  if (!(thread instanceof ThreadRuntime)) return;
  const liveMessageId = message.id;
  queueMicrotask(() => {
    const branch = thread.entries;
    const sourceEntryId = assistantAnchorForBranch(branch, rawMessage);
    if (!sourceEntryId) return;
    services.emit({
      type: "assistant-anchor",
      sessionId,
      id: liveMessageId,
      sourceEntryId,
      timestamp: message.timestamp,
      beforeMessageId: nextVisibleMessageId(branch, sourceEntryId, services.pinnedEntries(thread)),
    });
  });
}

function finishTool(event: any, thread: LiveTurnState, sessionId: string, cwd: string, services: SessionEventServices): void {
  const previous = thread.tools.get(event.toolCallId);
  const output = resultText(event.result);
  const preview = boundedToolOutput(output);
  const tool: UiToolRun = {
    id: event.toolCallId,
    name: event.toolName,
    args: (previous?.args ?? {}) as Record<string, unknown>,
    status: event.isError ? "error" : "done",
    output: preview,
    ...(preview !== output ? { outputTruncated: true, fullOutputAvailable: true } : {}),
    startedAt: previous?.startedAt ?? Date.now(),
    endedAt: Date.now(),
  };
  services.toolEnded(sessionId, tool, cwd);
  services.emit({ type: "tool-end", sessionId, tool });
  thread.tools.delete(tool.id);
  services.releaseTool(tool.id);
  services.log("tool.ended", `${event.toolName}:${tool.status}`);
}
