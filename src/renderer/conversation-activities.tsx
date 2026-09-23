import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ExtensionUiPrompt, HostSnapshot, UiToolRun } from "../shared/contracts";
import { answerTimestampAfter, type TranscriptDetail } from "../workbench/transcript-folding";
import { TaskProgress } from "./components/TaskProgress";
import { WorkGroup } from "./components/WorkRows";
import type { TranscriptActivity } from "./components/transcript-activity";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import type { ThreadViewStore } from "../workbench/thread-view-store";

export interface ConversationActivityInput {
  pendingNewThread: boolean;
  conversationSnapshot?: HostSnapshot;
  /** Whether the thread on screen runs; a draft's conversation snapshot never does. */
  running: boolean;
  /** The conversation's last message, where live work sits while a run is open. */
  lastMessageId?: string;
  prompts: readonly ExtensionUiPrompt[];
  registry: ExtensionRegistry;
  viewStore: ThreadViewStore;
  /** How much of each turn the transcript shows; see `TranscriptDetail`. */
  detail: TranscriptDetail;
  /** Lent to a tool card, the one row kind an extension draws itself. */
  actions?: WorkbenchActions;
  recoverThread(): Promise<unknown>;
  copyToolOutput(tool: UiToolRun): Promise<void>;
  abortSessionId?: string;
  abort(sessionId?: string): void;
}

const NO_TOOLS: readonly UiToolRun[] = [];
const NO_HISTORY: NonNullable<HostSnapshot["turnActivityHistory"]> = [];
const isActivityTool = (tool: UiToolRun) => tool.name !== "todo";

/** Whether the turn has work to show; a boolean, so tool output never changes it. */
export function hasActivityTools(view: ThreadViewStore): boolean {
  return view.getToolView().tools.some(isActivityTool);
}

/**
 * The transcript's own subscription to tool runs. Tool output changes these
 * rows and nothing above the transcript.
 */
export function useConversationActivities(input: ConversationActivityInput) {
  const {
    pendingNewThread, conversationSnapshot, running, lastMessageId, prompts, registry, viewStore, detail, actions,
    recoverThread, copyToolOutput, abortSessionId, abort,
  } = input;
  const { tools, toolAnchorId, turnActivityHistory } = useSyncExternalStore(viewStore.subscribeToTools, viewStore.getToolView);
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion);
  const activityTools = useMemo(() => tools.filter(isActivityTool), [tools]);
  const conversationActivityTools: readonly UiToolRun[] = pendingNewThread ? NO_TOOLS : activityTools;
  // A submitted prompt is visible before its run starts. Keep the previous
  // settled group on its original turn until agent-status opens new work.
  const visibleToolAnchorId = running ? lastMessageId : toolAnchorId ?? lastMessageId;
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
  const messages = conversationSnapshot?.messages;
  const historicalActivityRows = useMemo(() => conversationActivityHistory
    .filter((entry) => entry.id !== currentActivityHistoryId)
    .filter((entry) => entry.tools.some((tool) => tool.name !== "todo"))
    .map((entry) => {
      // The answer tells a tool that belonged to the turn from work that
      // started after it, which is the one thing the fold treats differently.
      const answerAt = answerTimestampAfter(messages ?? [], entry.anchorMessageId);
      return {
        id: entry.id,
        afterMessageId: entry.anchorMessageId,
        content: <WorkGroup
          id={entry.id}
          tools={entry.tools.filter((tool) => tool.name !== "todo")}
          registry={registry}
          detail={detail}
          streaming={entry.status === "running"}
          status={entry.status}
          {...(answerAt === undefined ? {} : { answerAt })}
          {...(actions ? { actions } : {})}
          onRecover={entry.status === "interrupted" ? () => void recoverThread() : undefined}
          onCopyOutput={copyToolOutput}
        />,
      };
    }), [actions, conversationActivityHistory, copyToolOutput, currentActivityHistoryId, detail, messages, recoverThread, registry]);
  // One element per progress value, so a tool flush leaves the row list's inputs alone.
  const taskProgress = conversationSnapshot?.isStreaming ? conversationSnapshot.taskProgress : undefined;
  const liveTaskProgress = useMemo(
    () => taskProgress ? <TaskProgress progress={taskProgress} placement="transcript" /> : undefined,
    [taskProgress],
  );
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
      content: <WorkGroup
        id="turn-activity"
        tools={conversationActivityTools}
        registry={registry}
        detail={detail}
        status={conversationSnapshot?.isStreaming ? "running" : "completed"}
        streaming={conversationSnapshot?.isStreaming}
        waiting={prompts.length > 0}
        {...(actions ? { actions } : {})}
        onRecover={() => void recoverThread()}
        onStop={() => abort(abortSessionId)}
        onCopyOutput={copyToolOutput}
      />,
    }] : []),
  ], [abort, abortSessionId, actions, conversationActivityTools, prompts.length, conversationSnapshot?.isStreaming, conversationSnapshot?.sessionId, conversationSnapshot?.taskHistory, copyToolOutput, detail, historicalActivityRows, liveTaskProgress, recoverThread, registry, registryVersion, visibleToolAnchorId]);

  return { conversationActivityTools, liveStatusLabel, transcriptActivities };
}
