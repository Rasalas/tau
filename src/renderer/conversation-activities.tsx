import { useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ExtensionUiPrompt, HostSnapshot, UiMessage, UiToolRun } from "../shared/contracts";
import { TaskProgress } from "./components/TaskProgress";
import { ToolGroup } from "./components/ToolGroup";
import type { TranscriptActivity } from "./components/transcript-activity";
import type { ExtensionRegistry } from "./extension-system";

interface PendingAssistantAnchor {
  id: string;
  timestamp: number;
  beforeMessageId?: string;
}

export interface ConversationActivityInput {
  pendingNewThread: boolean;
  activityTools: UiToolRun[];
  turnActivityHistory: NonNullable<HostSnapshot["turnActivityHistory"]>;
  conversationSnapshot?: HostSnapshot;
  toolAnchorId?: string;
  visibleToolAnchorId?: string;
  threadPrompts: ExtensionUiPrompt[];
  registry: ExtensionRegistry;
  registryVersion: number;
  pendingAssistantAnchors: MutableRefObject<Map<string, PendingAssistantAnchor>>;
  messages: MutableRefObject<UiMessage[]>;
  setMessages: Dispatch<SetStateAction<UiMessage[]>>;
  recoverThread(): Promise<unknown>;
  copyToolOutput(tool: UiToolRun): Promise<void>;
  abortSessionId?: string;
}

export function useConversationActivities(input: ConversationActivityInput) {
  const {
    pendingNewThread, activityTools, turnActivityHistory, conversationSnapshot, toolAnchorId,
    visibleToolAnchorId, threadPrompts, registry, registryVersion, pendingAssistantAnchors,
    messages, setMessages, recoverThread, copyToolOutput, abortSessionId,
  } = input;
  const conversationActivityTools = pendingNewThread ? [] : activityTools;
  const conversationActivityHistory = pendingNewThread
    ? []
    : (turnActivityHistory.length > 0 ? turnActivityHistory : conversationSnapshot?.turnActivityHistory ?? []);
  const currentActivityToolIds = new Set(conversationActivityTools.map((tool) => tool.id));
  const currentActivityHistoryId = conversationActivityTools.length > 0
    ? [...conversationActivityHistory].reverse().find((entry) => (
      (toolAnchorId !== undefined && entry.anchorMessageId === toolAnchorId)
      || entry.tools.some((tool) => currentActivityToolIds.has(tool.id))
    ))?.id
    : undefined;
  const historicalActivityRows = conversationActivityHistory
    .filter((entry) => entry.id !== currentActivityHistoryId)
    .filter((entry) => entry.tools.some((tool) => tool.name !== "todo"))
    .map((entry) => ({
      id: entry.id,
      afterMessageId: entry.anchorMessageId,
      content: <ToolGroup
        tools={entry.tools.filter((tool) => tool.name !== "todo")}
        registry={registry}
        streaming={entry.status === "running"}
        activityStatus={entry.status}
        onRecover={entry.status === "interrupted" ? () => void recoverThread() : undefined}
        onCopyOutput={copyToolOutput}
      />,
    }));
  const conversationPrompts = pendingNewThread ? [] : threadPrompts;
  const liveTaskProgress = conversationSnapshot?.isStreaming && conversationSnapshot.taskProgress
    ? <TaskProgress progress={conversationSnapshot.taskProgress} placement="transcript" />
    : undefined;
  const extensionRows = registry.getTranscriptRows(conversationSnapshot?.sessionId);
  const liveStatusLabel = registry.getLiveStatus(conversationSnapshot?.sessionId);

  useEffect(() => {
    const pending = pendingAssistantAnchors.current;
    if (pending.size === 0) return;
    const wanted = extensionRows.flatMap((row) => row.afterMessageId !== undefined && pending.has(row.afterMessageId) ? [row.afterMessageId] : []);
    if (wanted.length === 0) return;
    setMessages((current) => {
      let next = current;
      for (const sourceEntryId of new Set(wanted)) {
        const anchor = pending.get(sourceEntryId);
        if (!anchor) continue;
        pending.delete(sourceEntryId);
        if (next.some((message) => message.sourceEntryId === sourceEntryId || message.id === anchor.id)) continue;
        const marker: UiMessage = { id: anchor.id, sourceEntryId, role: "assistant", text: "", timestamp: anchor.timestamp };
        const beforeIndex = anchor.beforeMessageId === undefined
          ? -1
          : next.findIndex((message) => message.id === anchor.beforeMessageId || message.sourceEntryId === anchor.beforeMessageId);
        next = beforeIndex < 0 ? [...next, marker] : [...next.slice(0, beforeIndex), marker, ...next.slice(beforeIndex)];
      }
      if (next !== current) messages.current = next;
      return next;
    });
  }, [extensionRows, messages, pendingAssistantAnchors, setMessages]);

  const transcriptActivities = useMemo<readonly TranscriptActivity[]>(() => [
    ...historicalActivityRows,
    ...((conversationSnapshot?.taskHistory ?? []).map((entry) => ({
      id: entry.id,
      afterMessageId: entry.anchorMessageId,
      content: <TaskProgress progress={entry.progress} placement="transcript" />,
    }))),
    ...(liveTaskProgress ? [{ id: "live-task-progress", afterMessageId: visibleToolAnchorId, fallbackToTail: true, content: liveTaskProgress }] : []),
    ...extensionRows,
    ...(conversationActivityTools.length > 0 ? [{
      id: "turn-activity",
      afterMessageId: visibleToolAnchorId,
      fallbackToTail: true,
      content: <ToolGroup
        tools={conversationActivityTools}
        registry={registry}
        streaming={conversationSnapshot?.isStreaming}
        waiting={conversationPrompts.length > 0}
        onRecover={() => void recoverThread()}
        onStop={() => void window.tau?.abort(abortSessionId)}
        onCopyOutput={copyToolOutput}
      />,
    }] : []),
  ], [abortSessionId, conversationActivityTools, conversationPrompts.length, conversationSnapshot?.isStreaming, conversationSnapshot?.sessionId, conversationSnapshot?.taskHistory, copyToolOutput, historicalActivityRows, liveTaskProgress, recoverThread, registry, registryVersion, visibleToolAnchorId]);

  return { conversationActivityTools, conversationPrompts, liveStatusLabel, transcriptActivities };
}
