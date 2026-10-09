import type { WorkbenchActions } from "tau";
/**
 * Thread Title Generator's contract between its host entry and its desktop
 * entry. Core knows nothing about generated titles; it only renames threads.
 */
export const THREAD_TITLES_HOST_EXTENSION_ID = "tau.thread-titles";
export const TITLE_FAILED_EVENT = "title-failed";

/** Desktop service another kit reaches to name the thread on screen again (Thread Rail's row menu). */
export const THREAD_TITLES_SERVICE = "tau.thread-titles/titles";
export interface ThreadTitlesService {
  regenerate(actions: WorkbenchActions): Promise<void>;
}

/**
 * How the kit asks a model for a title, wherever it runs: the host half sends
 * it through `HostThread.complete`, the Pi half through Pi's own model
 * registry. Core knows none of this wording.
 */
export const TITLE_SYSTEM_PROMPT = "Create a concise coding-thread title as one plain-text noun phrase. Use 3-7 words and at most 60 characters. Name the concrete task, change, or decision. Ignore attachment filenames, timestamps and attachment boilerplate; use the user's request and the assistant's explanation to identify the task. Never use Markdown, quotes, terminal punctuation, a label, a complete sentence, or meta wording such as working on, help with, discussion about, or implementing.";

export const TITLE_USER_PROMPT = (conversation: string): string =>
  `Return only the plain-text title for this thread. Match the conversation's language.\n\n${conversation}`;
