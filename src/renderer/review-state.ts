// Review Kit only mounts core's overlay; `ReviewMode` and this state are core's.
import { getClientStorage } from "./client-storage";
import { reviewStateKey } from "./storage-keys";

export interface ReviewComment {
  id: string;
  path: string;
  line?: number;
  body: string;
  createdAt: number;
  resolved?: boolean;
}

export interface PersistedReviewState {
  readPaths: string[];
  comments: ReviewComment[];
}

const EMPTY_REVIEW_STATE: PersistedReviewState = { readPaths: [], comments: [] };

export function readReviewState(workspace: string, scope: string): PersistedReviewState {
  try {
    const parsed = JSON.parse(getClientStorage()?.get(reviewStateKey(workspace, scope)) ?? "null") as Partial<PersistedReviewState> | null;
    return {
      readPaths: Array.isArray(parsed?.readPaths) ? parsed.readPaths.filter((path): path is string => typeof path === "string") : [],
      comments: Array.isArray(parsed?.comments) ? parsed.comments.filter((comment): comment is ReviewComment => Boolean(comment)
        && typeof comment.id === "string" && typeof comment.path === "string" && typeof comment.body === "string") : [],
    };
  } catch {
    return EMPTY_REVIEW_STATE;
  }
}

export function writeReviewState(workspace: string, scope: string, state: PersistedReviewState): void {
  getClientStorage()?.set(reviewStateKey(workspace, scope), JSON.stringify(state));
}
