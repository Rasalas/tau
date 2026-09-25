// What the sync commands answer and emit; no imports, so the desktop half may read it.
// Paths are relative to the target: its `remotePath` on the server, its `context` folder locally.

/** Progress of a running `scan`, `compare` or `download` (`extension-event`, topic below). */
export const SYNC_PROGRESS_EVENT = "sync-progress";
export const SYNC_PROGRESS_TOPIC = "servers-sync";

export type SyncOperation = "scan" | "compare" | "download";
export type SyncPhase = "connect" | "list" | "hash" | "fetch" | "record" | "done";

export interface SyncProgress {
  operation: SyncOperation;
  workspace: string;
  targetId: string;
  phase: SyncPhase;
  /** Files handled in this phase so far. */
  done: number;
  total?: number;
  bytes?: number;
  totalBytes?: number;
}

/** `shell`: one `find` over ssh; `sftp`: folder by folder. */
export type ListMethod = "shell" | "sftp";
/** `tar`: one tar stream over ssh; `sftp`: file by file, several at once. */
export type FetchMethod = "tar" | "sftp";

export interface ScanFolder {
  path: string;
  files: number;
  bytes: number;
}

/** `scan`: what a download would fetch, before it does. */
export interface ScanSummary {
  targetId: string;
  /** `remotePath`, resolved on the server. */
  root: string;
  method: ListMethod;
  files: number;
  bytes: number;
  /** Folders one and two levels down, with what they hold after ignoring. */
  folders: ScanFolder[];
  /** Folders left out whole by an ignore rule; `.git` is always left out and not listed. */
  ignoredFolders: string[];
  ignoredFiles: number;
  /** Symlinks and special files; Tau neither follows nor copies them. */
  skipped: number;
  /** Whether the local checkout's Git ignore rules applied (false outside a repository). */
  gitRules: boolean;
}

export type SyncChange = "added" | "modified" | "deleted";

/** A local change the server does not have yet (working tree ↔ mirror state). */
export interface PendingRow {
  path: string;
  change: SyncChange;
  /** Local size; absent for a deletion. */
  size?: number;
}

export interface FileStamp {
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

/** A change on the server since the mirror state (server ↔ mirror state). */
export interface DriftRow {
  path: string;
  change: SyncChange;
  /** False when only size and mtime say so and no hash confirmed it. */
  certain: boolean;
  server?: FileStamp;
  mirror?: FileStamp;
}

export interface MirrorInfo {
  commit: string;
  /** ISO time of the last read of the server. */
  at: string;
  files: number;
}

export interface CompareResult {
  targetId: string;
  /** Absent before the first download: nothing to compare against. */
  mirror?: MirrorInfo;
  pending?: {
    rows: PendingRow[];
    /** On the upload block list (trust.json): never pending, never uploaded. */
    withheld: string[];
  };
  drift?: {
    rows: DriftRow[];
    method: ListMethod;
    /** Every file hashed, not only size and mtime. */
    thorough: boolean;
  };
}

export interface DownloadResult {
  targetId: string;
  commit: string;
  method: FetchMethod;
  files: number;
  bytes: number;
  /** Local files written (new, or replaced with `overwrite`). */
  written: number;
  /** Local files that already held the server's content. */
  unchanged: number;
  /** Local files that differ from the server and were left as they are; they show as pending. */
  kept: string[];
  /** Files deleted locally since the last download; left deleted, they show as pending deletions. */
  keptDeleted: string[];
  failed: Array<{ path: string; message: string }>;
  /** Live credentials found in what came down (paths in trust.json, never values). */
  liveConfigs: number;
}
