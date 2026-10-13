import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ExtensionUiPrompt, HostSnapshot, UiToolOutputPreview, UiToolRun, UiTurnActivityEntry } from "../shared/contracts";
import type { TranscriptDetail } from "../workbench/transcript-folding";
import { ActivityMessageIndex, type ActivitySegment } from "../workbench/activity-message-index";
import { TaskProgress } from "./components/TaskProgress";
import { WorkGroup } from "./components/WorkRows";
import { WorkDisclosures } from "./components/work-disclosures";
import { completedWorkMetadata, type TranscriptActivity } from "./components/transcript-activity";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import { toolCardTranscriptRows } from "./tool-card-transcript-rows";

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
  const currentActivityHistoryId = useMemo(() => {
    if (conversationActivityTools.length === 0) return undefined;
    const ids = new Set(conversationActivityTools.map((tool) => tool.id));
    for (let index = conversationActivityHistory.length - 1; index >= 0; index -= 1) {
      const entry = conversationActivityHistory[index];
      if ((toolAnchorId !== undefined && entry.anchorMessageId === toolAnchorId)
        || entry.tools.some((tool) => ids.has(tool.id))) return entry.id;
    }
    return undefined;
  }, [conversationActivityHistory, conversationActivityTools, toolAnchorId]);
  const { messages, activityRevision } = useSyncExternalStore(viewStore.subscribeToTranscript, viewStore.getTranscript);
  const messageIndex = useMemo(() => new ActivityMessageIndex(viewStore.getTranscript().messages), [viewStore, activityRevision]);
  const sessionId = conversationSnapshot?.sessionId;
  // A thread opened again starts with every settled turn folded.
  const disclosures = useMemo(() => new WorkDisclosures(), [sessionId]);
  const historicalCache = useMemo(() => new WeakMap<UiTurnActivityEntry, {
    answerAt?: number; keepOpen: boolean; segments: ActivitySegment[]; rows: TranscriptActivity[];
  }>(), [actions, copyToolOutput, detail, disclosures, loadToolOutput, recoverThread, registry, registryVersion]);
  const historicalActivityRows = useMemo(() => conversationActivityHistory
    .filter((entry) => entry.id !== currentActivityHistoryId)
    .filter((entry) => entry.tools.some((tool) => tool.name !== "todo"))
    .flatMap((entry) => {
      // The answer tells a tool that belonged to the turn from work that
      // started after it, which is the one thing the fold treats differently.
      const answerAt = messageIndex.answerAfter(entry.anchorMessageId);
      const segments = messageIndex.splitTools(entry.tools.filter(isActivityTool), entry.anchorMessageId, (tool) => Boolean(registry.toolCardFor(tool)));
      const keepOpen = disclosures.openedInTurn(entry.tools[0]!.id);
      const cached = historicalCache.get(entry);
      if (cached && cached.answerAt === answerAt && cached.keepOpen === keepOpen && sameSegments(cached.segments, segments)) return cached.rows;
      const rows = segments.map((segment, index) => ({
        id: index === 0 ? entry.id : `${entry.id}:${segment.tools[0].id}`,
        afterMessageId: segment.anchorMessageId,
        ...completedWorkMetadata(segment.tools, entry.status, (tool) => Boolean(registry.toolCardFor(tool)), keepOpen),
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
      historicalCache.set(entry, { answerAt, keepOpen, segments, rows });
      return rows;
    }), [actions, conversationActivityHistory, copyToolOutput, currentActivityHistoryId, detail, disclosures, historicalCache, loadToolOutput, messageIndex, recoverThread, registry]);
  // One element per progress value, so a tool flush leaves the row list's inputs alone.
  const taskProgress = conversationSnapshot?.isStreaming ? conversationSnapshot.taskProgress : undefined;
  const liveTaskProgress = useMemo(
    () => taskProgress ? <TaskProgress progress={taskProgress} /> : undefined,
    [taskProgress],
  );
  const extensionRows = registry.getTranscriptRows(conversationSnapshot?.sessionId);
  const liveStatusLabel = conversationSnapshot?.isCompacting
    ? "Compacting context…" : registry.getLiveStatus(conversationSnapshot?.sessionId);

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
  const cardTools = useMemo(() => actions ? [...new Map([
    ...conversationActivityHistory.flatMap((entry) => entry.tools), ...conversationActivityTools,
  ].map((tool) => [tool.id, tool])).values()].filter((tool) => registry.toolCardFor(tool)?.transcriptRows) : NO_TOOLS,
  [actions, conversationActivityHistory, conversationActivityTools, registry, registryVersion]);
  const transcriptActivities = useMemo<readonly TranscriptActivity[]>(() => [
    ...historicalActivityRows,
    ...((conversationSnapshot?.taskHistory ?? []).map((entry) => ({
      id: entry.id,
      afterMessageId: entry.anchorMessageId,
      content: <TaskProgress progress={entry.progress} />,
    }))),
    ...(liveTaskProgress ? [{ id: "live-task-progress", afterMessageId: visibleToolAnchorId, fallbackToTail: true, content: liveTaskProgress }] : []),
    ...extensionRows,
    ...messageIndex.splitTools(conversationActivityTools, visibleToolAnchorId, (tool) => Boolean(registry.toolCardFor(tool))).map((segment, index, segments) => ({
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
    ...toolCardTranscriptRows(cardTools, messages, registry, actions),
  ], [abort, abortSessionId, actions, cardTools, conversationActivityTools, prompts.length, replied, waitingFor, conversationSnapshot?.isStreaming, conversationSnapshot?.sessionId, conversationSnapshot?.taskHistory, copyToolOutput, detail, disclosures, historicalActivityRows, liveTaskProgress, loadToolOutput, recoverThread, registry, registryVersion, visibleToolAnchorId, messageIndex, messages]);

  return { thinking, liveStatusLabel, transcriptActivities };
}

function sameSegments(left: readonly ActivitySegment[], right: readonly ActivitySegment[]): boolean {
  return left.length === right.length && left.every((segment, index) => (
    segment.anchorMessageId === right[index].anchorMessageId
    && segment.tools.length === right[index].tools.length
    && segment.tools.every((tool, toolIndex) => tool === right[index].tools[toolIndex])
  ));
}
