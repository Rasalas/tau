/**
 * Prompt Tools' contract: the commands between its two halves and the types it
 * copies from Composer Context's chip service. Core routes both by id.
 */
export const PROMPT_TOOLS_ID = "tau.prompt-tools";

/** Composer Context's chip service; the types below are copied, a kit never imports another kit. */
export const CHIPS_SERVICE = "tau.composer-context/chips";

export type ChipKind = "file" | "text-excerpt" | "pull-request" | "attachment";

export interface ChipInput {
  kind: ChipKind;
  label?: string;
  payload: Record<string, unknown>;
}

export interface Chip extends ChipInput {
  id: string;
  label: string;
}

export interface ComposerContextChips {
  addChip(chip: ChipInput): string;
  removeChip(id: string): void;
  chips(): readonly Chip[];
  subscribe(listener: () => void): () => void;
}

/** The option the kit declares; `queue` is what core does without it. */
export const FOLLOW_UP_OPTION = "followUpBehavior";
export type FollowUpBehavior = "queue" | "steer";

/** Twenty; the oldest goes when a twenty-first arrives. */
export const MAX_STASH_ENTRIES = 20;
/** Base64 characters of images one entry may hold. */
export const MAX_STASH_IMAGE_CHARS = 40 * 1024 * 1024;
/** Prompts the history reads from the project's other threads. */
export const PROJECT_HISTORY_THREADS = 30;
export const PROJECT_HISTORY_PROMPTS = 200;

export interface StashedChip {
  kind: ChipKind;
  label: string;
  payload: Record<string, unknown>;
}

export interface StashedImage {
  kind: "image";
  name: string;
  mimeType: string;
  size: number;
  /** Base64; absent in a listing. */
  data?: string;
}

/** One stashed draft of a project: its text, its chips and its images. */
export interface StashEntry {
  id: string;
  createdAt: number;
  text: string;
  chips: StashedChip[];
  images: StashedImage[];
  /**
   * The project it was stashed in, as the thread's `cwd`. An entry from before
   * it was recorded has it when a thread of this machine still names the project.
   */
  project?: string;
}

/** Entries of other projects the composer menu lists at most, newest first. */
export const MAX_OTHER_STASH_ENTRIES = 30;

export interface PromptToolsHostCommands {
  "stash-list": { input: { project: string }; output: StashEntry[] };
  "stash-add": { input: { project: string; text: string; chips: StashedChip[]; images: StashedImage[] }; output: { entry: StashEntry; evicted?: StashEntry } };
  /** The entries of every other project's stash on this machine, newest first, at most `MAX_OTHER_STASH_ENTRIES`. */
  "stash-list-others": { input: { project?: string }; output: StashEntry[] };
  /**
   * Restores an entry: answers it with its images and removes it; `undefined` when it is gone.
   * `anyProject` finds it by id in whichever project's stash holds it.
   */
  "stash-take": { input: { project: string; id: string } | { id: string; anyProject: true }; output: StashEntry | undefined };
  "stash-drop": { input: { project: string; id: string } | { id: string; anyProject: true }; output: void };
  /** The prompts of the project's other threads, newest first. */
  "project-prompts": { input: { cwd: string; excludeSessionId?: string }; output: string[] };
}

/** Emitted with `{ project }` whenever a project's stash changed, so every client recounts; `project` is empty when unknown. */
export const STASH_CHANGED_EVENT = "stash-changed";
