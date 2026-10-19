/**
 * Composer Context's contract: the chip service other kits use, and the
 * commands between its own two halves. Core routes both by id and never
 * looks inside.
 */
export const COMPOSER_CONTEXT_ID = "tau.composer-context";

/**
 * The chip service. Another kit reaches it with
 * `context.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, …)`
 * and copies these types; a kit never imports another kit.
 */
export const COMPOSER_CONTEXT_CHIPS_SERVICE = "tau.composer-context/chips";

/** Drag contract: JSON of ChipPayloads["pull-request"], also copied by Review Kit. */
export const PULL_REQUEST_DRAG_TYPE = "application/x-tau-pull-request+json";

/** Drag contract: JSON of ChipPayloads["thread"], also copied by Workspace Kit's rail. */
export const THREAD_DRAG_TYPE = "application/x-tau-thread+json";

/** The tag a sent excerpt is wrapped in; the transcript draws the block as a chip with a popover. */
export const EXCERPT_TAG = "excerpt";

/** Workspace Kit's store, for the project the composer is drafting in. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";

export type ChipKind = "file" | "text-excerpt" | "pull-request" | "thread" | "attachment";

export interface ChipPayloads {
  /** A workspace-relative path; lines are 1-based and inclusive. */
  file: { path: string; startLine?: number; endLine?: number };
  /**
   * Where the text came from ("Terminal", "Review comment on src/a.ts:12"), the text itself, and the user's comment on it.
   * `messageId` is the transcript message it was taken from, so the sent excerpt can link back to it.
   */
  "text-excerpt": { source: string; text: string; comment?: string; messageId?: string };
  "pull-request": { number: number; title: string; url: string; branch?: string };
  /** Another thread of this host, sent as a bounded snapshot of its latest turns. */
  thread: { threadId: string; title: string };
  /** A file on the host's disk; `path` is absent while it is still being stored. */
  attachment: { name: string; mimeType: string; size: number; path?: string };
}

export type ChipInput = {
  [K in ChipKind]: {
    kind: K;
    /** What the chip reads; derived from the payload when absent. */
    label?: string;
    payload: ChipPayloads[K];
    /** Draws the chip's label instead of the text; a React node. Not persisted. */
    render?: (chip: Chip) => unknown;
  }
}[ChipKind];

export type Chip = ChipInput & { id: string; label: string };

export interface ComposerContextChips {
  /** Puts a chip into the composer on screen and answers with its id. */
  addChip(chip: ChipInput): string;
  removeChip(id: string): void;
  /** The chips of the composer on screen, in the order they were added. */
  chips(): readonly Chip[];
  subscribe(listener: () => void): () => void;
}

/** Limits: a hundred files a message, 10 MB an image, 50 MB any other file, videos included. */
export const MAX_ATTACHMENT_CHIPS = 100;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** A paste this large becomes a text-file attachment instead of editor text. */
export const PASTE_FOLD_BYTES = 32 * 1024;
/** Text a runtime without file support gets inline, per file; past it, the path. */
export const EMBED_TEXT_BYTES = 200 * 1024;
/** One `store-attachment` call's bytes; a 50 MB file in one base64 frame would pass the socket's 64 MiB cap. */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** A thread's snapshot as the host stored it: a Markdown file, with its text when small enough to send inline. */
export interface ThreadSnapshot { name: string; path: string; size: number; text?: string; turns: number; total: number }
export interface ReadFileRequest { path: string; startLine?: number; endLine?: number }
export interface ReadFileResult { path: string; text?: string; truncated?: boolean; error?: string }
export interface DescribedAttachment { path: string; text?: string; truncated?: boolean }
export interface PullRequestSummary { number: number; title: string; url: string; branch?: string; draft?: boolean }

export interface ComposerContextHostCommands {
  /** The first chunk creates the file; later ones name it in `into` and append. `size` is the file's size so far. */
  "store-attachment": { input: { scope: string; name: string; mimeType: string; data: string; into?: string }; output: { path: string; size: number } };
  "read-files": { input: { cwd: string; files: ReadFileRequest[] }; output: ReadFileResult[] };
  "describe-attachments": { input: { paths: string[] }; output: DescribedAttachment[] };
  "snapshot-thread": { input: { scope: string; threadId: string; title: string }; output: ThreadSnapshot };
  "list-files": { input: { cwd: string; query: string }; output: string[] };
  "list-pull-requests": { input: { cwd: string }; output: PullRequestSummary[] };
}
