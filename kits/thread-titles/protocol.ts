import type { WorkbenchActions } from "tau";
/**
 * Thread Title Generator's contract between its host entry and its desktop
 * entry. Core knows nothing about generated titles; it only renames threads.
 */
export const THREAD_TITLES_HOST_EXTENSION_ID = "tau.thread-titles";
export const TITLE_FAILED_EVENT = "title-failed";
export const TITLE_INSTRUCTIONS_SETTING = "instructions";
export const TITLE_INSTRUCTIONS_LIMIT = 2_000;
const normalizeInstructions = (value: string): string => value.replace(/\r\n?/gu, "\n").trim();

export function titleInstructionsError(value: string): string | undefined {
  if (normalizeInstructions(value).length > TITLE_INSTRUCTIONS_LIMIT) return `Use at most ${TITLE_INSTRUCTIONS_LIMIT.toLocaleString("en-US")} characters.`;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) return "Remove control characters from the instructions.";
  }
  return undefined;
}

/** Settings and attached-runtime commands use the same bound and normalization. */
export function titleInstructions(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("Thread title instructions must be text.");
  const problem = titleInstructionsError(value);
  if (problem) throw new Error(problem);
  return normalizeInstructions(value);
}

/** Desktop service another kit reaches to name the thread on screen again (Thread Rail's row menu). */
export const THREAD_TITLES_SERVICE = "tau.thread-titles/titles";
export interface ThreadTitlesService {
  regenerate(actions: WorkbenchActions): Promise<void>;
  /**
   * Names one thread again by id, on screen or not, with the model the settings
   * name; rejects with the reason it could not. The rail's selection calls it
   * for each thread it regenerates.
   */
  regenerateThread(sessionId: string): Promise<void>;
}

/**
 * How the kit asks a model for a title, wherever it runs: the host half sends
 * it through `HostThread.complete`, the Pi half through Pi's own model
 * registry. Core knows none of this wording.
 */
export const TITLE_SYSTEM_PROMPT = "Create a concise coding-thread title as one plain-text noun phrase. Use 3-7 words and at most 60 characters. Name the concrete task, change, or decision. Ignore attachment filenames, timestamps and attachment boilerplate; use the user's request and the assistant's explanation to identify the task. Never use Markdown, quotes, terminal punctuation, a label, a complete sentence, or meta wording such as working on, help with, discussion about, or implementing.";

export function titleSystemPrompt(instructions?: unknown): string {
  const additional = titleInstructions(instructions);
  return additional ? `${TITLE_SYSTEM_PROMPT}\n\nAdditional title instructions:\n${additional}` : TITLE_SYSTEM_PROMPT;
}

export const TITLE_USER_PROMPT = (conversation: string): string =>
  `Return only the plain-text title for this thread. Match the conversation's language.\n\n${conversation}`;
