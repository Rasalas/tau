import type { UiMessage } from "../../shared/contracts";
import { startsTurn } from "../../shared/message-turns";
import { formatWorkDuration } from "../../workbench/transcript-folding";
import type { TranscriptActivity } from "./transcript-activity";

export interface CompletedTurnWork {
  id: string;
  label: string;
  messages: readonly UiMessage[];
  activities: readonly TranscriptActivity[];
  keepOpen: boolean;
}

/** The final answer stays in the virtual list; completed commentary and ordinary tools share its prompt's disclosure. */
export function projectCompletedTurnWork(
  messages: readonly UiMessage[], activities: readonly TranscriptActivity[], streaming: boolean,
) {
  const hidden = new Set<string>();
  const foldedActivities = new Set<string>();
  const work = new Map<string, CompletedTurnWork>();
  const aliases = new Map<string, string>();
  const answersWithoutThinking = new Set<string>();
  const prompts = messages.flatMap((message, index) => startsTurn(message) ? [index] : []);
  const byReference = new Map<string, number>();
  messages.forEach((message, index) => {
    byReference.set(message.id, index);
    if (message.sourceEntryId) byReference.set(message.sourceEntryId, index);
  });
  const activitiesByTurn = new Map<number, TranscriptActivity[]>();
  for (const activity of activities) {
    const index = activity.afterMessageId ? byReference.get(activity.afterMessageId) : messages.length - 1;
    if (index === undefined) continue;
    let low = 0;
    let high = prompts.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (prompts[mid]! <= index) low = mid + 1;
      else high = mid;
    }
    const turn = low - 1;
    if (turn >= 0) activitiesByTurn.set(turn, [...(activitiesByTurn.get(turn) ?? []), activity]);
  }
  for (let turn = 0; turn < prompts.length; turn += 1) {
    const start = prompts[turn]!;
    const end = prompts[turn + 1] ?? messages.length;
    if (streaming && end === messages.length) continue;
    const prompt = messages[start]!;
    const reply = messages.slice(start + 1, end);
    const final = [...reply].reverse().find((message) => message.role === "assistant" && message.text.trim());
    // A failed or unfinished answer must remain readable where it happened.
    if (!final || reply.at(-1)?.error || final.error) continue;
    const finalIndex = byReference.get(final.id)!;
    const turnActivities = activitiesByTurn.get(turn) ?? [];
    if (turnActivities.some((activity) => activity.preventTurnFold)) continue;
    const progress = reply.filter((message) => message.role === "assistant"
      && !message.error && !message.excludedFromContext && byReference.get(message.id)! < finalIndex);
    if (final.thinking?.trim() && !final.excludedFromContext) {
      progress.push({ ...final, id: `${final.id}:thinking`, text: "", sourceEntryId: undefined });
      answersWithoutThinking.add(final.id);
    }
    const tools = turnActivities.filter((activity) => {
      const index = activity.afterMessageId ? byReference.get(activity.afterMessageId) : messages.length - 1;
      return activity.foldWithTurn && index !== undefined && index >= start && index < finalIndex;
    });
    if (progress.length === 0 && tools.length === 0) continue;
    for (const message of progress) {
      hidden.add(message.id);
      aliases.set(message.id, prompt.id);
      if (message.sourceEntryId) aliases.set(message.sourceEntryId, prompt.id);
    }
    tools.forEach((activity) => foldedActivities.add(activity.id));
    const failedCalls = tools.reduce((count, activity) => count + (activity.failedTools ?? 0), 0);
    work.set(prompt.id, {
      id: `completed:${prompt.id}`,
      label: [`Worked for ${formatWorkDuration(final.timestamp - prompt.timestamp)}`,
        failedCalls > 0 ? `${failedCalls} failed ${failedCalls === 1 ? "call" : "calls"}` : undefined].filter(Boolean).join(" · "),
      messages: progress,
      activities: tools,
      keepOpen: tools.some((activity) => activity.keepTurnOpen),
    });
  }
  return {
    messages: messages.filter((message) => !hidden.has(message.id)).map((message) =>
      answersWithoutThinking.has(message.id) ? { ...message, thinking: undefined } : message),
    activities: activities.filter((activity) => !foldedActivities.has(activity.id)).map((activity) =>
      activity.afterMessageId && aliases.has(activity.afterMessageId)
        ? { ...activity, afterMessageId: aliases.get(activity.afterMessageId) } : activity),
    work,
    aliases,
  };
}
