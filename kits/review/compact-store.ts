import type { ReviewSource } from "./compact-model.js";

export type CompactReviewPage = "files" | "diff" | "comment" | "commit" | "request";

export interface CompactReviewState {
  sessionId?: string;
  /** Unset until the user picks one; the latest turn or the working tree is shown then. */
  source?: ReviewSource;
  page: CompactReviewPage;
  path?: string;
  /** The source the open comment's lines belong to (`sourceKey`). */
  draftSource?: string;
  commitMessage: string;
  request: { title: string; body: string; draft: boolean };
}

/**
 * Where the phone's review was left. The sheet unmounts its panel when it
 * closes, so this outlives it; texts typed into it are kept across threads.
 */
export class CompactReviewStore {
  private state: CompactReviewState = { page: "files", commitMessage: "", request: { title: "", body: "", draft: false } };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): CompactReviewState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  update(patch: Partial<CompactReviewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Another thread starts at its own file list; what was typed stays. */
  follow(sessionId: string | undefined): void {
    if (sessionId === this.state.sessionId) return;
    this.update({ sessionId, source: undefined, page: "files", path: undefined });
  }
}
