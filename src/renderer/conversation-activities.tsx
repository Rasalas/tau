import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ExtensionUiPrompt, HostSnapshot, UiMessage, UiToolOutputPreview, UiToolRun } from "../shared/contracts";
import { answerTimestampAfter, type TranscriptDetail } from "../workbench/transcript-folding";
import { TaskProgress } from "./components/TaskProgress";
import { WorkGroup } from "./components/WorkRows";
import { WorkDisclosures } from "./components/work-disclosures";
import { completedWorkMetadata, type TranscriptActivity } from "./components/transcript-activity";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import type { ThreadViewStore } from "../workbench/thread-view-store";

export interface ConversationActivityInput {
  pendingNewThread: boolean;
  conversationSnapshot?: HostSnapshot;
  /** Whether the thread on screen runs; a draft's conversation snapshot never does. */
  running: boolean;
  /** The conversation's last message, used before work has an anchor. */
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
  loadToolOutput(tool: UiToolRun): Promise<UiToolOutputPreview | undefined>;
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
    pendingNewThread, conversationSnapshot, lastMessageId, prompts, registry, viewStore, detail, actions,
    recoverThread, copyToolOutput, loadToolOutput, abortSessionId, abort,
  } = input;
  const { tools, toolAnchorId, turnActivityHistory } = useSyncExternalStore(viewStore.subscribeToTools, viewStore.getToolView);
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion);
  const activityTools = useMemo(() => tools.filter(isActivityTool), [tools]);
  const conversationActivityTools: readonly UiToolRun[] = pendingNewThread ? NO_TOOLS : activityTools;
  // A submitted prompt is visible before its run starts. Keep the previous
  // settled group on its original turn until agent-status opens new work.
  const visibleToolAnchorId = toolAnchorId ?? lastMessageId;
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
  const messages = useSyncExternalStore(viewStore.subscribeToTranscript, viewStore.getTranscript).messages;
  const sessionId = conversationSnapshot?.sessionId;
  // A thread opened again starts with every settled turn folded.
  const disclosures = useMemo(() => new WorkDisclosures(), [sessionId]);
  const historicalActivityRows = useMemo(() => conversationActivityHistory
    .filter((entry) => entry.id !== currentActivityHistoryId)
    .filter((entry) => entry.tools.some((tool) => tool.name !== "todo"))
    .flatMap((entry) => {
      // The answer tells a tool that belonged to the turn from work that
      // started after it, which is the one thing the fold treats differently.
      const answerAt = answerTimestampAfter(messages ?? [], entry.anchorMessageId);
      return splitActivityTools(entry.tools.filter(isActivityTool), messages ?? [], entry.anchorMessageId).map((segment, index) => ({
        id: index === 0 ? entry.id : `${entry.id}:${segment.tools[0].id}`,
        afterMessageId: segment.anchorMessageId,
        ...completedWorkMetadata(segment.tools, entry.status, (tool) => Boolean(registry.toolCardFor(tool)), disclosures.openedInTurn(entry.tools[0]!.id)),
        content: <WorkGroup
          id={`${entry.id}:${segment.tools[0].id}`}
          tools={segment.tools}
          registry={registry}
          detail={detail}
          disclosures={disclosures}
          streaming={false}
          status={entry.status === "running" ? "completed" : entry.status}
          {...(answerAt === undefined ? {} : { answerAt })}
          {...(actions ? { actions } : {})}
          onRecover={entry.status === "interrupted" ? () => void recoverThread() : undefined}
          onCopyOutput={copyToolOutput}
          onLoadOutput={loadToolOutput}
        />,
      }));
    }), [actions, conversationActivityHistory, copyToolOutput, currentActivityHistoryId, detail, disclosures, loadToolOutput, messages, recoverThread, registry]);
  // One element per progress value, so a tool flush leaves the row list's inputs alone.
  const taskProgress = conversationSnapshot?.isStreaming ? conversationSnapshot.taskProgress : undefined;
  const liveTaskProgress = useMemo(
    () => taskProgress ? <TaskProgress progress={taskProgress} /> : undefined,
    [taskProgress],
  );
  const extensionRows = registry.getTranscriptRows(conversationSnapshot?.sessionId);
  const liveStatusLabel = registry.getLiveStatus(conversationSnapshot?.sessionId);

  useEffect(() => {
    // An empty live assistant row only becomes visible once an extension row
    // asks to sit at its entry.
    viewStore.resolvePendingAnchors(extensionRows.flatMap((row) => row.afterMessageId === undefined ? [] : [row.afterMessageId]));
  }, [extensionRows, viewStore]);

  // T3 Code's rule: output after the newest call ends its live row, and "Thinking" stands in
  // for any turn without a live row, unless its reasoning streams in the message itself.
  const newest = conversationActivityTools.at(-1);
  const last = messages?.at(-1);
  const replied = newest !== undefined && last?.role === "assistant" && last.timestamp > newest.startedAt && Boolean(last.text.trim() || last.thinking?.trim());
  const thinking = Boolean(conversationSnapshot?.isStreaming) && !(last?.role === "assistant" && !last.text && last.thinking?.trim())
    && (!newest || newest.status === "error" || replied);

  // A yes-or-no question is an approval; the live line then says what it waits to do.
  const waitingFor = prompts[0] ? (prompts[0].kind === "confirm" ? "approval" : "question") : undefined;
  const transcriptActivities = useMemo<readonly TranscriptActivity[]>(() => [
    ...historicalActivityRows,
    ...((conversationSnapshot?.taskHistory ?? []).map((entry) => ({
      id: entry.id,
      afterMessageId: entry.anchorMessageId,
      content: <TaskProgress progress={entry.progress} />,
    }))),
    ...(liveTaskProgress ? [{ id: "live-task-progress", afterMessageId: visibleToolAnchorId, fallbackToTail: true, content: liveTaskProgress }] : []),
    ...extensionRows,
    ...splitActivityTools(conversationActivityTools, messages ?? [], visibleToolAnchorId).map((segment, index, segments) => ({
      id: index === 0 ? "turn-activity" : `turn-activity:${segment.tools[0].id}`,
      afterMessageId: segment.anchorMessageId,
      ...completedWorkMetadata(segment.tools, !conversationSnapshot?.isStreaming && prompts.length === 0 ? "completed" : "running", (tool) => Boolean(registry.toolCardFor(tool)), disclosures.openedInTurn(conversationActivityTools[0]!.id)),
      fallbackToTail: true,
      content: <WorkGroup
        // Each batch keeps its disclosure when later messages or calls arrive.
        id={`turn-activity:${segment.tools[0].id}`}
        tools={segment.tools}
        registry={registry}
        detail={detail}
        disclosures={disclosures}
        status={conversationSnapshot?.isStreaming ? "running" : "completed"}
        streaming={conversationSnapshot?.isStreaming && index === segments.length - 1 && !replied}
        waiting={prompts.length > 0}
        {...(waitingFor ? { waitingFor } : {})}
        {...(actions ? { actions } : {})}
        onRecover={() => void recoverThread()}
        onStop={() => abort(abortSessionId)}
        onCopyOutput={copyToolOutput}
        onLoadOutput={loadToolOutput}
      />,
    })),
  ], [abort, abortSessionId, actions, conversationActivityTools, prompts.length, replied, waitingFor, conversationSnapshot?.isStreaming, conversationSnapshot?.sessionId, conversationSnapshot?.taskHistory, copyToolOutput, detail, disclosures, historicalActivityRows, liveTaskProgress, loadToolOutput, recoverThread, registry, registryVersion, visibleToolAnchorId, messages]);

  return { thinking, liveStatusLabel, transcriptActivities };
}

/** Keep calls in message order, including work after a steering prompt and its reply. */
function splitActivityTools(tools: readonly UiToolRun[], messages: readonly UiMessage[], anchorMessageId?: string) {
  const anchorIndex = anchorMessageId === undefined ? -1 : messages.findIndex((message) => message.id === anchorMessageId || message.sourceEntryId === anchorMessageId);
  const following = anchorIndex < 0 ? [] : messages.slice(anchorIndex + 1);
  const segments: { anchorMessageId?: string; tools: UiToolRun[] }[] = [];
  for (const tool of tools) {
    let anchor = anchorMessageId;
    for (const message of following) {
      if (message.role === "user") {
        if (tool.status !== "running" && message.timestamp > tool.startedAt) break;
        anchor = message.id;
        continue;
      }
      if (message.text.trim() && message.timestamp <= tool.startedAt) anchor = message.id;
    }
    const previous = segments.at(-1);
    if (previous && previous.anchorMessageId === anchor) previous.tools.push(tool);
    else segments.push({ anchorMessageId: anchor, tools: [tool] });
  }
  return segments;
}
