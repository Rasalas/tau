// Review Kit only mounts core's overlay; `ReviewMode` and this state are core's.
import { getClientStorage } from "../workbench/client-storage";
import { reviewStateKey } from "../workbench/storage-keys";

/** Which files of a review were marked viewed. Line comments belong to whoever fills the line seam. */
export interface PersistedReviewState {
  readPaths: string[];
}

export function readReviewState(workspace: string, scope: string): PersistedReviewState {
  try {
    const parsed = JSON.parse(getClientStorage()?.get(reviewStateKey(workspace, scope)) ?? "null") as Partial<PersistedReviewState> | null;
    return { readPaths: Array.isArray(parsed?.readPaths) ? parsed.readPaths.filter((path): path is string => typeof path === "string") : [] };
  } catch {
    return { readPaths: [] };
  }
}

export function writeReviewState(workspace: string, scope: string, state: PersistedReviewState): void {
  getClientStorage()?.set(reviewStateKey(workspace, scope), JSON.stringify(state));
}
