import { useEffect, useMemo } from "react";
import type { ExtensionUiPrompt, HostSnapshot, UiToolRun } from "../shared/contracts";
import { TaskProgress } from "./components/TaskProgress";
import { ToolGroup } from "./components/ToolGroup";
import type { TranscriptActivity } from "./components/transcript-activity";
import type { ExtensionRegistry } from "./extension-system";
import type { ThreadViewStore } from "./thread-view-store";

export interface ConversationActivityInput {
  pendingNewThread: boolean;
  activityTools: UiToolRun[];
  turnActivityHistory: readonly NonNullable<HostSnapshot["turnActivityHistory"]>[number][];
  conversationSnapshot?: HostSnapshot;
  toolAnchorId?: string;
  visibleToolAnchorId?: string;
  threadPrompts: ExtensionUiPrompt[];
  registry: ExtensionRegistry;
  registryVersion: number;
  viewStore: ThreadViewStore;
  recoverThread(): Promise<unknown>;
  copyToolOutput(tool: UiToolRun): Promise<void>;
  abortSessionId?: string;
  abort(sessionId?: string): void;
}

const NO_TOOLS: readonly UiToolRun[] = [];
const NO_PROMPTS: ExtensionUiPrompt[] = [];
const NO_HISTORY: NonNullable<HostSnapshot["turnActivityHistory"]> = [];

export function useConversationActivities(input: ConversationActivityInput) {
  const {
    pendingNewThread, activityTools, turnActivityHistory, conversationSnapshot, toolAnchorId,
    visibleToolAnchorId, threadPrompts, registry, registryVersion, viewStore,
    recoverThread, copyToolOutput, abortSessionId, abort,
  } = input;
  const conversationActivityTools: readonly UiToolRun[] = pendingNewThread ? NO_TOOLS : activityTools;
  const conversationActivityHistory = pendingNewThread
    ? NO_HISTORY
    : (turnActivityHistory.length > 0 ? turnActivityHistory : conversationSnapshot?.turnActivityHistory ?? NO_HISTORY);
  const currentActivityToolIds = new Set(conversationActivityTools.map((tool) => tool.id));
  const currentActivityHistoryId = conversationActivityTools.length > 0
    ? [...conversationActivityHistory].reverse().find((entry) => (
      (toolAnchorId !== undefined && entry.anchorMessageId === toolAnchorId)
      || entry.tools.some((tool) => currentActivityToolIds.has(tool.id))
    ))?.id
    : undefined;
  const historicalActivityRows = useMemo(() => conversationActivityHistory
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
    })), [conversationActivityHistory, copyToolOutput, currentActivityHistoryId, recoverThread, registry]);
  const conversationPrompts = pendingNewThread ? NO_PROMPTS : threadPrompts;
  const liveTaskProgress = conversationSnapshot?.isStreaming && conversationSnapshot.taskProgress
    ? <TaskProgress progress={conversationSnapshot.taskProgress} placement="transcript" />
    : undefined;
  const extensionRows = registry.getTranscriptRows(conversationSnapshot?.sessionId);
  const liveStatusLabel = registry.getLiveStatus(conversationSnapshot?.sessionId);

  useEffect(() => {
    // An empty live assistant row only becomes visible once an extension row
    // asks to sit at its entry.
    viewStore.resolvePendingAnchors(extensionRows.flatMap((row) => row.afterMessageId === undefined ? [] : [row.afterMessageId]));
  }, [extensionRows, viewStore]);

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
        onStop={() => abort(abortSessionId)}
        onCopyOutput={copyToolOutput}
      />,
    }] : []),
  ], [abort, abortSessionId, conversationActivityTools, conversationPrompts.length, conversationSnapshot?.isStreaming, conversationSnapshot?.sessionId, conversationSnapshot?.taskHistory, copyToolOutput, historicalActivityRows, liveTaskProgress, recoverThread, registry, registryVersion, visibleToolAnchorId]);

  return { conversationActivityTools, conversationPrompts, liveStatusLabel, transcriptActivities };
}
