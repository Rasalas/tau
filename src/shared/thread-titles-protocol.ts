/**
 * Thread Title Generator's contract between its host entry and its desktop
 * entry. Core knows nothing about generated titles; it only renames threads.
 */
export const THREAD_TITLES_HOST_EXTENSION_ID = "tau.thread-titles";

export interface ThreadTitlesHostCommands {
  /**
   * Titles the thread with a model. Without `force` it stays silent when the
   * thread already has a name or nothing to title yet; with `force` those are errors.
   */
  "generate": {
    input: { provider: string; modelId: string; force?: boolean; sessionId?: string };
    output: { title: string } | undefined;
  };
}
