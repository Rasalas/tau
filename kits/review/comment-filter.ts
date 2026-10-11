import type { PreferencesStore } from "tau";
import { REVIEW_HOST_EXTENSION_ID, type PullRequestComment, type PullRequestDetail, type PullRequestThread } from "./protocol.js";

/** Which kinds of comment a request's conversation shows; both are hidden until asked for. */
export interface CommentFilter {
  bots: boolean;
  resolved: boolean;
}

export const BOTS_OPTION = "pr-comments-bots";
export const RESOLVED_OPTION = "pr-comments-resolved";

/** The reader's habit, not a property of one request, so it is kept in the kit's preferences. */
export function commentFilter(preferences: PreferencesStore): CommentFilter {
  return {
    bots: preferences.optionValue(REVIEW_HOST_EXTENSION_ID, BOTS_OPTION, false),
    resolved: preferences.optionValue(REVIEW_HOST_EXTENSION_ID, RESOLVED_OPTION, false),
  };
}

export function setCommentFilter(preferences: PreferencesStore, key: keyof CommentFilter, value: boolean): void {
  preferences.setOption(REVIEW_HOST_EXTENSION_ID, key === "bots" ? BOTS_OPTION : RESOLVED_OPTION, value);
}

/** A comment on a resolved conversation, or a review that was dismissed. */
export const isFinished = (comment: PullRequestComment, thread?: Pick<PullRequestThread, "resolved">): boolean =>
  thread?.resolved === true || comment.verdict === "dismissed";

/** What the filter leaves, and how many it took out; a resolved bot comment is both kinds and needs both shown. */
export function applyCommentFilter<T>(entries: readonly T[], filter: CommentFilter, read: (entry: T) => { comment: PullRequestComment; thread?: Pick<PullRequestThread, "resolved"> | undefined }): { shown: T[]; hidden: number } {
  const shown = entries.filter((entry) => {
    const { comment, thread } = read(entry);
    return (filter.bots || !comment.author.bot) && (filter.resolved || !isFinished(comment, thread));
  });
  return { shown, hidden: entries.length - shown.length };
}

/** The request as the timeline draws it: bot comments and dismissed reviews left out unless the filter asks for them. */
export function filterTimelineComments(detail: PullRequestDetail, filter: CommentFilter): { detail: PullRequestDetail; hidden: number } {
  const { shown, hidden } = applyCommentFilter(detail.comments, filter, (comment) => ({ comment }));
  return hidden === 0 ? { detail, hidden } : { detail: { ...detail, comments: shown }, hidden };
}
