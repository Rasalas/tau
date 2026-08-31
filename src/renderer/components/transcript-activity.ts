import type { ReactNode } from "react";
import type { UiMessage } from "../../shared/contracts";

/** A piece of transcript work rendered after the message that owns it. */
export interface TranscriptActivity {
  id: string;
  afterMessageId?: string;
  /** Keep transient activity visible at the current tail when its anchor races. */
  fallbackToTail?: boolean;
  content: ReactNode;
}

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

/**
 * Resolve activity anchors once for the transcript window. Keeping this beside
 * the activity type prevents the history and active-turn render paths from
 * drifting apart as activities are added.
 */
export function groupTranscriptActivities(
  messages: UiMessage[],
  activities: readonly TranscriptActivity[],
): Map<string, TranscriptActivity[]> {
  return groupTranscriptActivitiesForMessageIds(
    new Set(messages.map((message) => message.id)),
    messages.at(-1)?.id,
    activities,
  );
}

export function unanchoredTranscriptActivitiesForMessageCount(
  messageCount: number,
  activities: readonly TranscriptActivity[],
): TranscriptActivity[] {
  if (messageCount > 0) return [];
  return activities.filter((activity) => !activity.afterMessageId || activity.fallbackToTail);
}

/** Activities can be displayed without a message while a new run is starting. */
export function unanchoredTranscriptActivities(
  messages: UiMessage[],
  activities: readonly TranscriptActivity[],
): TranscriptActivity[] {
  return unanchoredTranscriptActivitiesForMessageCount(messages.length, activities);
}
