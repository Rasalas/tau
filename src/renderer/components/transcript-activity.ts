import type { ReactNode } from "react";
import type { UiToolRun, UiTurnActivityEntry } from "../../shared/contracts";

/** A piece of transcript work rendered after the message that owns it. */
export interface TranscriptActivity {
  id: string;
  afterMessageId?: string;
  /** Keep transient activity visible at the current tail when its anchor races. */
  fallbackToTail?: boolean;
  /** Completed core work may share the turn's disclosure; extension rows opt out by default. */
  foldWithTurn?: boolean;
  /** An explicit work disclosure was opened while this turn ran. */
  keepTurnOpen?: boolean;
  failedTools?: number;
  preventTurnFold?: boolean;
  content: ReactNode;
}

/** Tool errors do not make a successful final answer unfinished. Cards and questions stay outside the fold. */
export function completedWorkMetadata(tools: readonly UiToolRun[], status: UiTurnActivityEntry["status"], hasCard: (tool: UiToolRun) => boolean, keepOpen: boolean) {
  const completed = status === "completed" || status === "error";
  return {
    foldWithTurn: completed && tools.every((tool) => tool.status !== "running" && !hasCard(tool)
      && !/ask_user|request_takeover|approval|question/iu.test(tool.name)),
    keepTurnOpen: keepOpen,
    preventTurnFold: !completed || tools.some((tool) => tool.status === "running"),
    failedTools: tools.filter((tool) => tool.status === "error").length,
  };
}

/** Resolves activity anchors once for the transcript window, so every render path agrees. */
export function groupTranscriptActivitiesForMessageIds(
  messageIds: ReadonlySet<string>,
  tailMessageId: string | undefined,
  activities: readonly TranscriptActivity[],
): Map<string, TranscriptActivity[]> {
  const grouped = new Map<string, TranscriptActivity[]>();
  for (const activity of activities) {
    const anchor = activity.afterMessageId
      ? messageIds.has(activity.afterMessageId)
        ? activity.afterMessageId
        : activity.fallbackToTail ? tailMessageId : undefined
      : tailMessageId;
    if (!anchor) continue;
    const entries = grouped.get(anchor) ?? [];
    entries.push(activity);
    grouped.set(anchor, entries);
  }
  return grouped;
}

/** Activities can be displayed without a message while a new run is starting. */
export function unanchoredTranscriptActivitiesForMessageCount(
  messageCount: number,
  activities: readonly TranscriptActivity[],
): TranscriptActivity[] {
  if (messageCount > 0) return [];
  return activities.filter((activity) => !activity.afterMessageId || activity.fallbackToTail);
}
