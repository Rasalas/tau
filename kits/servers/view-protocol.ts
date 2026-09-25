// What the server view's commands answer and emit; type imports only, so the desktop half may read it.
import type { ServerCapabilities, ServerProtocol, TargetLevel } from "./protocol.js";
import type { DriftRow, ListMethod, MirrorInfo, SyncChange } from "./sync/protocol.js";

/** A target's status changed (`{ workspace, status }`), for the clients that watch the topic. */
export const SERVERS_STATUS_EVENT = "status";
export const SERVERS_STATUS_TOPIC = "servers-status";

/** The stage tab of one target; params `{ workspace, targetId }`. */
export const SERVER_TARGET_TAB = "servers.target";
/** The sheet a compact client opens from its title bar. */
export const SERVERS_COMPACT_PANEL = "servers";
export const SERVERS_SETTINGS_PAGE = "servers.settings";

/**
 * Worst first: what the title-bar dot shows when a project has several targets.
 * `unusable`: sftp.json names no server Tau can reach; `never-read`: no mirror state yet.
 */
export type ServerSyncState = "unusable" | "unreachable" | "conflict" | "drift" | "pending" | "never-read" | "in-sync";
export const SYNC_STATE_ORDER: readonly ServerSyncState[] = ["unusable", "unreachable", "conflict", "drift", "pending", "never-read", "in-sync"];

/** One pending file as the upload list shows it: its default choice and why a credentials file starts unchosen. */
export interface PendingUploadRow {
  path: string;
  change: SyncChange;
  size?: number;
  /** The upload's default: deletions are chosen too (the user's decision 3), credential files are not. */
  selected: boolean;
  /** Set when the local file or the server's copy holds credentials: labels of what was found, never a value. */
  credentials?: string[];
}

export interface ServerGitCommit {
  sha: string;
  subject: string;
  author?: string;
  /** Seconds since the epoch. */
  at?: number;
}

/** The server's own Git, read with `--no-optional-locks` and never written. */
export type ServerGitInfo =
  | { repository: true; branch?: string; upstream?: string; ahead?: number; behind?: number; changed: number; files: Array<{ path: string; code: string }>; commits: ServerGitCommit[] }
  | { repository: false; reason: string };

export interface LiveConfigRow {
  path: string;
  label: string;
}

export interface TargetStatus {
  targetId: string;
  label: string;
  /** `sftp://user@host:port/path`. */
  address: string;
  protocol: ServerProtocol;
  /** Local folder relative to the project, `""` for the project itself. */
  context: string;
  profile?: string;
  level: TargetLevel;
  state: ServerSyncState;
  /** A check of the server is running. */
  checking: boolean;
  /** Absent before the first download. */
  mirror?: MirrorInfo;
  /** Local changes the server does not have yet, the upload list's rows; capped at `PENDING_ROW_CAP`. */
  pending: PendingUploadRow[];
  pendingTotal: number;
  /** On the upload block list: never pending, never uploaded. */
  withheld: string[];
  /** Changes on the server since the mirror state; absent until a check reached the server. */
  drift?: DriftRow[];
  driftMethod?: ListMethod;
  /** ISO time the server was last reached. */
  checkedAt?: string;
  /** Paths changed locally and on the server. */
  conflicts: string[];
  /** Why the last check could not reach the server. */
  unreachable?: string;
  /** What else went wrong in the last check, with the server reached. */
  error?: string;
  /** Why sftp.json names no server Tau can reach. */
  unusable?: string;
  serverGit?: ServerGitInfo;
  caps?: ServerCapabilities;
  liveConfigs: LiveConfigRow[];
  /** Threads with a deployment not committed yet; the rail marks them. */
  uncommittedThreads: string[];
}

export interface ServersStatus {
  /** The checkout the status is of, as the host knows it. */
  workspace: string;
  /** Absent when the project has no sftp.json. */
  file?: string;
  targets: TargetStatus[];
}

export interface ServersStatusEvent {
  workspace: string;
  status: ServersStatus;
}

export const PENDING_ROW_CAP = 2000;

export interface HistoryFile {
  path: string;
  change: SyncChange;
}

/** One recorded server state: a read (download) or, later, a deployment. */
export interface HistoryEntry {
  commit: string;
  parent?: string;
  /** ISO time. */
  at: string;
  subject: string;
  kind: "read" | "change";
  added: number;
  modified: number;
  deleted: number;
  /** Capped at `HISTORY_FILE_CAP`; the counts are complete. */
  files: HistoryFile[];
}

export const HISTORY_FILE_CAP = 300;

export interface ServerHistory {
  targetId: string;
  entries: HistoryEntry[];
}

/** `pending`: the mirror state against the local file; `history`: a recorded state against the one before. */
export type ServerDiffSource = { source: "pending"; path: string } | { source: "history"; commit: string; path: string };

export function decodeServersStatus(value: unknown): ServersStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = value as Partial<ServersStatus>;
  if (typeof status.workspace !== "string" || !Array.isArray(status.targets)) return undefined;
  return status as ServersStatus;
}
