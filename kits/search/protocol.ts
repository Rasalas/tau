/**
 * Search Kit's contract between its two halves. Paths travel relative to the
 * project root, POSIX-style; a line is 1-based and a range is a pair of string
 * offsets into the text it came with.
 */
export const SEARCH_KIT_ID = "tau.search";

/** "Go to file" for another kit (Workspace Kit's Files panel); `onPick` takes the path instead of the stage. */
export const SEARCH_FILES_SERVICE = "tau.search/files";
export interface SearchFilesService {
  pickFile(onPick?: (path: string) => void): void;
}

/** Workspace Kit's store, copied down to what this kit reads; a kit never imports another kit. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export interface WorkspaceStoreView {
  getSnapshot(): { cwd?: string; changes?: { branch?: string; files?: ReadonlyArray<{ path: string; status: string }> } };
  subscribe(listener: () => void): () => void;
}

/**
 * The runtime kits whose threads have no session file: each answers
 * `thread-texts` from its own store, granted to this kit, so the palette finds
 * their threads by what was said in them while nobody has them open.
 */
export const THREAD_TEXT_SOURCES = ["tau.codex", "tau.claude-code", "tau.antigravity", "tau.opencode", "tau.grok", "tau.cursor"] as const;

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
  /** Opt into completeness metadata; old callers still receive an array. */
  includeStatus?: boolean;
  /** A newer query cancels the previous query from this window. */
  channel?: string;
  limit?: number;
  /** The thread on screen, read from its runtime when it has no session file. */
  activeSessionId?: string;
}

export interface ThreadSearchResult {
  matches: ThreadMatch[];
  truncated: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface ThreadMatch {
  sessionId: string;
  path: string;
  role: "user" | "assistant";
  /** Where the query was found, cut to a line's worth. */
  snippet: string;
}

export interface ThreadFindInput {
  sessionId: string;
  query: string;
}

/** The messages of one thread that hold a query, whatever part of the history a client has loaded. */
export interface ThreadFindResult {
  /** Message ids as the transcript draws them, oldest first. */
  messageIds: string[];
  /** The thread has more matches than `THREAD_FIND_LIMIT`; the newest are kept. */
  truncated: boolean;
}

/** Matches one in-thread find returns at most. */
export const THREAD_FIND_LIMIT = 2_000;

/** Review Kit, which keeps the pull and merge requests each thread links; `thread-request-links` names `SEARCH_KIT_ID` as a caller. */
export const REVIEW_KIT_ID = "tau.review";

export interface ThreadRequestInput {
  /** A request number (`#95`, `acme/tau#95`), a request URL, or words of its title or head branch. */
  query: string;
  limit?: number;
}

/** A thread whose stored request links match the query. */
export interface ThreadRequestMatch {
  sessionId: string;
  requests: Array<{ number: number; repository: string; url: string; state: "open" | "closed" | "merged" | null; title: string | null; headBranch: string | null }>;
}

export interface SearchHostCommands {
  "content": { input: ContentSearchInput; output: ContentSearchResult };
  "files": { input: FileSearchInput; output: FileSearchResult };
  /** Forgets a project's file list; the next `files` reads it again. */
  "invalidate": { input: { cwd?: string }; output: void };
  "threads": { input: ThreadSearchInput; output: ThreadMatch[] | ThreadSearchResult };
  /** Which messages of one thread say the query, over its whole history; the desktop half hands it to core's transcript find. */
  "find-in-thread": { input: ThreadFindInput; output: ThreadFindResult };
  /** Threads found through their linked requests; empty when Review Kit is not there. */
  "thread-requests": { input: ThreadRequestInput; output: ThreadRequestMatch[] };
}
