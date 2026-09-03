import type { HostSnapshot, UiComposerCommand } from "../shared/contracts.js";
import { normalizeTranscriptCursorBoundaries } from "../shared/host-protocol.js";
import { transcriptPagingNegotiated, type PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { mergeTaskProgressHistory, taskProgressFromMessages, taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import { resolveClientTurnIdentity } from "../shared/transcript-turn.js";
import { withClientTurnIdentity, type ClientTurnLedger } from "./client-turn-ledger.js";
import {
  bridgeMessagesOffset,
  cleanThreadTitle,
  firstSentence,
  historyCompletenessForBridgeSnapshot,
  isVisibleMessage,
  lastTurnActivityFromMessages,
  mapMessage,
  mapModel,
  safeSessionTitle,
  turnActivityHistoryFromMessages,
  visibleTitleText,
  type MessageMappingOptions,
} from "./host-messages.js";
import { PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import { skillInvocationCommand } from "./skill-invocation.js";
import { hostCursorAtBridgeValue } from "./transcript-cursor.js";

/** Skill commands carry the invocation form of the adapter that will run them. */
export function composerCommandsForAdapter(
  commands: readonly UiComposerCommand[],
  adapter: AgentRuntimeAdapter,
): UiComposerCommand[] {
  return commands.map((command) => {
    if (command.source !== "skill") return { ...command };
    const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
    return { ...command, skillCommand: skillInvocationCommand(name, adapter) };
  });
}

/**
 * The bridge is implemented by Pi itself, so its messages read with the Pi
 * dialect whatever model provider the snapshot names.
 */
export function bridgeMessageMapping(snapshot: PiBridgeSnapshot | undefined): MessageMappingOptions {
  return {
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    skillCommands: composerCommandsForAdapter(snapshot?.composerCommands ?? [], PI_AGENT_RUNTIME_ADAPTER),
  };
}

/** Projects the snapshot a Pi terminal publishes into the workbench's host snapshot. */
export function bridgeHostSnapshot(snapshot: PiBridgeSnapshot, clientTurns: ClientTurnLedger): HostSnapshot {
  const mapping = { ...bridgeMessageMapping(snapshot), pinned: new Set(snapshot.pinnedEntryIds ?? []) };
  const composerCommands = composerCommandsForAdapter(snapshot.composerCommands ?? [], PI_AGENT_RUNTIME_ADAPTER);
  const rawMessageOffset = bridgeMessagesOffset(snapshot.messagesOffset);
  const messages = snapshot.messages.flatMap((rawMessage, index) => {
    const mapped = mapMessage(rawMessage, rawMessageOffset === undefined ? index : rawMessageOffset + index, mapping);
    if (!isVisibleMessage(mapped, mapping.pinned)) return [];
    const raw = rawMessage && typeof rawMessage === "object" ? rawMessage : undefined;
    const identity = mapped.role === "user"
      ? resolveClientTurnIdentity(
        mapped,
        raw ? clientTurns.identityForRaw(raw) ?? clientTurns.identityForMessage(snapshot.sessionId, mapped) : undefined,
      )
      : undefined;
    if (identity && raw) clientTurns.remember(snapshot.sessionId, mapped, identity, raw);
    return [withClientTurnIdentity(mapped, identity)];
  });
  const firstUserMessage = messages.find((message) => message.role === "user");
  const taskHistory = mergeTaskProgressHistory(
    snapshot.taskHistory,
    taskProgressHistoryFromMessages(snapshot.messages),
  );
  const activityHistory = snapshot.turnActivityHistory
    ?? turnActivityHistoryFromMessages(snapshot.activityMessages ?? snapshot.messages);
  const latestActivity = activityHistory.at(-1);
  const historyCompleteness = historyCompletenessForBridgeSnapshot(snapshot);
  const olderCursor = !transcriptPagingNegotiated(snapshot.capabilities) || snapshot.olderCursor === undefined
    ? undefined
    : hostCursorAtBridgeValue(snapshot.olderCursor);
  const cursorBoundaries = normalizeTranscriptCursorBoundaries(
    undefined,
    firstUserMessage?.id,
    olderCursor,
  );
  return {
    cwd: snapshot.cwd,
    threadId: snapshot.sessionId,
    providerSessionId: snapshot.sessionId,
    sessionId: snapshot.sessionId,
    sessionName: safeSessionTitle(snapshot.sessionName),
    sessionTitle: cleanThreadTitle(safeSessionTitle(snapshot.sessionName) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
    model: snapshot.model ? mapModel(snapshot.model) : undefined,
    runtimeCapabilities: snapshot.runtimeCapabilities ?? PI_AGENT_RUNTIME_ADAPTER.capabilities,
    backendKind: "pi",
    models: snapshot.models.map(mapModel),
    thinkingLevel: snapshot.thinkingLevel,
    thinkingLevels: snapshot.thinkingLevels,
    messages,
    ...(transcriptPagingNegotiated(snapshot.capabilities) ? { transcriptWindow: "bounded" as const } : {}),
    ...(olderCursor ? { olderCursor } : {}),
    ...(firstUserMessage ? { cursorBeforeMessageId: firstUserMessage.id } : {}),
    ...(cursorBoundaries ? { cursorBoundaries } : {}),
    historyCompleteness,
    isStreaming: snapshot.isStreaming,
    activeTools: snapshot.activeTools,
    turnActivity: latestActivity
      ? { tools: latestActivity.tools, ...(latestActivity.anchorMessageId ? { anchorMessageId: latestActivity.anchorMessageId } : {}) }
      : lastTurnActivityFromMessages(snapshot.activityMessages ?? snapshot.messages),
    turnActivityHistory: activityHistory,
    ...(snapshot.turnActivityHistoryComplete !== undefined
      ? { turnActivityHistoryComplete: snapshot.turnActivityHistoryComplete }
      : {}),
    taskProgress: snapshot.taskProgress ?? taskProgressFromMessages(snapshot.messages),
    taskHistory,
    allTools: snapshot.allTools,
    composerCommands,
    extensionCount: 0,
    supportsImageInput: snapshot.supportsImageInput,
    contextUsage: snapshot.contextUsage && snapshot.contextUsage.tokens !== null && snapshot.contextUsage.percent !== null
      ? { tokens: snapshot.contextUsage.tokens, contextWindow: snapshot.contextUsage.contextWindow, percent: snapshot.contextUsage.percent }
      : undefined,
  };
}
