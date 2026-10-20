import type { UiMessage } from "../../shared/contracts";
import { formatWorkDuration } from "../../workbench/transcript-folding";
import type { TranscriptActivity } from "./transcript-activity";

export interface CompletedTurnWork {
  id: string;
  label: string;
  messages: readonly UiMessage[];
  activities: readonly TranscriptActivity[];
  keepOpen: boolean;
}

const NO_ACTIVITIES: readonly TranscriptActivity[] = [];

interface TurnFold {
  /** The turn's messages and activities the fold was made from. */
  members: readonly UiMessage[];
  activities: readonly TranscriptActivity[];
  work?: CompletedTurnWork;
  /** The final answer without the thinking that moved into the work. */
  answer?: UiMessage;
}

/** What one projection hands the next, so a streamed frame keeps every settled turn's objects. */
export class CompletedTurnWorkCache {
  folds = new Map<string, TurnFold>();
  aliases = new Map<string, string>();
}

function sameFold(fold: TurnFold, messages: readonly UiMessage[], start: number, end: number, activities: readonly TranscriptActivity[]): boolean {
  return fold.members.length === end - start && fold.members.every((message, index) => message === messages[start + index])
    && fold.activities.length === activities.length && fold.activities.every((activity, index) => activity === activities[index]);
}

function sameAliases(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

/** One turn: its prompt first, then everything that answered it. */
function foldTurn(members: readonly UiMessage[], activities: readonly TranscriptActivity[]): TurnFold {
  const fold: TurnFold = { members, activities };
  const prompt = members[0]!;
  let finalAt = members.length - 1;
  while (finalAt > 0 && !(members[finalAt]!.role === "assistant" && members[finalAt]!.text.trim())) finalAt -= 1;
  const final = finalAt > 0 ? members[finalAt]! : undefined;
  // A failed or unfinished answer must remain readable where it happened.
  if (!final || members.at(-1)?.error || final.error) return fold;
  if (activities.some((activity) => activity.preventTurnFold)) return fold;
  const byReference = new Map<string, number>();
  members.forEach((message, index) => {
    byReference.set(message.id, index);
    if (message.sourceEntryId) byReference.set(message.sourceEntryId, index);
  });
  const progress = members.filter((message, index) => index > 0 && index < finalAt
    && message.role === "assistant" && !message.error && !message.excludedFromContext);
  if (final.thinking?.trim() && !final.excludedFromContext) {
    progress.push({ ...final, id: `${final.id}:thinking`, text: "", sourceEntryId: undefined });
    fold.answer = { ...final, thinking: undefined };
  }
  const tools = activities.filter((activity) => {
    const index = activity.afterMessageId ? byReference.get(activity.afterMessageId) : members.length - 1;
    return activity.foldWithTurn && index !== undefined && index < finalAt;
  });
  if (progress.length === 0 && tools.length === 0) return fold;
  const failedCalls = tools.reduce((count, activity) => count + (activity.failedTools ?? 0), 0);
  fold.work = {
    id: `completed:${prompt.id}`,
    label: [`Worked for ${formatWorkDuration(final.timestamp - prompt.timestamp)}`,
      failedCalls > 0 ? `${failedCalls} failed ${failedCalls === 1 ? "call" : "calls"}` : undefined].filter(Boolean).join(" · "),
    messages: progress,
    activities: tools,
    keepOpen: tools.some((activity) => activity.keepTurnOpen),
  };
  return fold;
}

/**
 * Each prompt or wake keeps its final answer; its completed work shares the input's disclosure.
 * With a cache, a turn whose messages and activities are the same objects keeps its work and answer.
 */
export function projectCompletedTurnWork(
  messages: readonly UiMessage[], activities: readonly TranscriptActivity[], streaming: boolean, cache?: CompletedTurnWorkCache,
) {
  const hidden = new Set<string>();
  const foldedActivities = new Set<string>();
  const work = new Map<string, CompletedTurnWork>();
  const aliases = new Map<string, string>();
  const answers = new Map<string, UiMessage>();
  const folds = new Map<string, TurnFold>();
  // Wakes do not increment the user's turn number, but their answers must not
  // become commentary folded under an earlier prompt when the thread settles.
  const prompts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
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
    if (turn < 0) continue;
    const entries = activitiesByTurn.get(turn);
    if (entries) entries.push(activity);
    else activitiesByTurn.set(turn, [activity]);
  }
  for (let turn = 0; turn < prompts.length; turn += 1) {
    const start = prompts[turn]!;
    const end = prompts[turn + 1] ?? messages.length;
    if (streaming && end === messages.length) continue;
    const prompt = messages[start]!;
    const turnActivities = activitiesByTurn.get(turn) ?? NO_ACTIVITIES;
    const previous = cache?.folds.get(prompt.id);
    const fold = previous && sameFold(previous, messages, start, end, turnActivities)
      ? previous : foldTurn(messages.slice(start, end), turnActivities);
    folds.set(prompt.id, fold);
    if (!fold.work) continue;
    if (fold.answer) answers.set(fold.answer.id, fold.answer);
    for (const message of fold.work.messages) {
      hidden.add(message.id);
      aliases.set(message.id, prompt.id);
      if (message.sourceEntryId) aliases.set(message.sourceEntryId, prompt.id);
    }
    fold.work.activities.forEach((activity) => foldedActivities.add(activity.id));
    work.set(prompt.id, fold.work);
  }
  if (cache) {
    cache.folds = folds;
    if (!sameAliases(cache.aliases, aliases)) cache.aliases = aliases;
  }
  return {
    messages: messages.filter((message) => !hidden.has(message.id)).map((message) => answers.get(message.id) ?? message),
    activities: activities.filter((activity) => !foldedActivities.has(activity.id)).map((activity) =>
      activity.afterMessageId && aliases.has(activity.afterMessageId)
        ? { ...activity, afterMessageId: aliases.get(activity.afterMessageId) } : activity),
    work,
    aliases: cache?.aliases ?? aliases,
  };
}
