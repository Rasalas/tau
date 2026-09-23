/**
 * Search Kit's contract between its two halves. Paths travel relative to the
 * project root, POSIX-style; a line is 1-based and a range is a pair of string
 * offsets into the text it came with.
 */
export const SEARCH_KIT_ID = "tau.search";

/** Workspace Kit's store, copied down to what this kit reads; a kit never imports another kit. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export interface WorkspaceStoreView {
  getSnapshot(): { cwd?: string; changes: unknown };
  subscribe(listener: () => void): () => void;
}

/**
 * The runtime kits whose threads have no session file: each answers
 * `thread-texts` from its own store, granted to this kit, so the palette finds
 * their threads by what was said in them while nobody has them open.
 */
export const THREAD_TEXT_SOURCES = ["tau.codex", "tau.claude-code", "tau.antigravity", "tau.opencode"] as const;

/** Matches one content search returns at most, and per file. */
export const CONTENT_LIMIT = 500;
export const CONTENT_PER_FILE = 100;
/** A result line longer than this is cut to a window around its first match. */
export const LINE_PREVIEW = 240;
/** Files one list holds; a larger project is searched in its first this many. */
export const FILE_LIMIT = 50_000;

export interface ContentSearchInput {
  cwd?: string;
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  limit?: number;
  /** Searches on one channel cancel one another; a window uses one. */
  channel?: string;
}

export interface ContentMatch {
  path: string;
  line: number;
  /** The line, trimmed and cut around its first match; `ranges` index into it. */
  text: string;
  ranges: Array<[start: number, end: number]>;
}

export interface ContentSearchResult {
  matches: ContentMatch[];
  truncated: boolean;
  /** `walker` when ripgrep is not installed and the kit read the files itself. */
  engine: "ripgrep" | "walker";
  /** A newer search on the same channel took over before this one finished. */
  cancelled?: boolean;
  /** The query is not a regular expression the engine accepts. */
  error?: string;
}

export interface FileSearchInput {
  cwd?: string;
  query: string;
  limit?: number;
}

export interface FileMatch {
  path: string;
  /** Offsets into `path` the query matched, for highlighting. */
  positions: number[];
}

export interface FileSearchResult {
  files: FileMatch[];
  /** How many files the project list holds. */
  total: number;
}

export interface ThreadSearchInput {
  query: string;
  limit?: number;
  /** The thread on screen, read from its runtime when it has no session file. */
  activeSessionId?: string;
}

export interface ThreadMatch {
  sessionId: string;
  path: string;
  role: "user" | "assistant";
  /** Where the query was found, cut to a line's worth. */
  snippet: string;
}

export interface SearchHostCommands {
  "content": { input: ContentSearchInput; output: ContentSearchResult };
  "files": { input: FileSearchInput; output: FileSearchResult };
  /** Forgets a project's file list; the next `files` reads it again. */
  "invalidate": { input: { cwd?: string }; output: void };
  "threads": { input: ThreadSearchInput; output: ThreadMatch[] };
}
