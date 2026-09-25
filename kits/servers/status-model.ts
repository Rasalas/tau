// Pure status logic both halves share: which state a target is in, and how it reads.
import type { DriftRow, PendingRow } from "./sync/protocol.js";
import { SYNC_STATE_ORDER, type PendingUploadRow, type ServerSyncState, type TargetStatus } from "./view-protocol.js";

export interface StateInput {
  usable: boolean;
  unreachable?: string;
  mirror?: unknown;
  pending: readonly Pick<PendingRow, "path">[];
  drift?: readonly Pick<DriftRow, "path">[];
}

/** Paths changed on both sides since the mirror state. */
export function conflictsOf(pending: readonly Pick<PendingRow, "path">[], drift: readonly Pick<DriftRow, "path">[] | undefined): string[] {
  if (!drift?.length) return [];
  const local = new Set(pending.map((row) => row.path));
  return drift.filter((row) => local.has(row.path)).map((row) => row.path);
}

export function deriveState(input: StateInput): ServerSyncState {
  if (!input.usable) return "unusable";
  if (input.unreachable) return "unreachable";
  if (!input.mirror) return "never-read";
  if (conflictsOf(input.pending, input.drift).length > 0) return "conflict";
  if (input.drift?.length) return "drift";
  if (input.pending.length > 0) return "pending";
  return "in-sync";
}

export function worstState(states: Iterable<ServerSyncState>): ServerSyncState | undefined {
  let worst: number | undefined;
  for (const state of states) {
    const rank = SYNC_STATE_ORDER.indexOf(state);
    if (worst === undefined || rank < worst) worst = rank;
  }
  return worst === undefined ? undefined : SYNC_STATE_ORDER[worst];
}

export const STATE_LABELS: Readonly<Record<ServerSyncState, string>> = {
  unusable: "Not usable",
  unreachable: "Unreachable",
  conflict: "Conflict",
  drift: "Server changed",
  pending: "Not uploaded",
  "never-read": "Not read yet",
  "in-sync": "In sync",
};

/** The dot's tone: the same four colours the rest of the workbench uses for status. */
export const STATE_TONES: Readonly<Record<ServerSyncState, "danger" | "warn" | "info" | "ok" | "muted">> = {
  unusable: "danger",
  unreachable: "danger",
  conflict: "danger",
  drift: "warn",
  pending: "info",
  "never-read": "muted",
  "in-sync": "ok",
};

export function formatAddress(target: { protocol: string; username?: string; host: string; port: number; remotePath: string }): string {
  const user = target.username ? `${target.username}@` : "";
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.protocol}://${user}${host || "?"}:${target.port}${target.remotePath.startsWith("/") ? "" : "/"}${target.remotePath}`;
}

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** One sentence per target, for a tooltip and the rail. */
export function statusSentence(target: Pick<TargetStatus, "state" | "pendingTotal" | "drift" | "conflicts" | "unreachable" | "unusable" | "checking">): string {
  const drift = target.drift?.length ?? 0;
  switch (target.state) {
    case "unusable": return target.unusable ?? "sftp.json names no server Tau can reach.";
    case "unreachable": return `Could not reach the server${target.unreachable ? `: ${target.unreachable}` : "."}`;
    case "never-read": return target.checking ? "Reading the server…" : "Tau has not read this server yet.";
    case "conflict": return `${files(target.conflicts.length)} changed here and on the server.`;
    case "drift": return `The server changed ${files(drift)}${target.pendingTotal ? `; ${files(target.pendingTotal)} not uploaded` : ""}.`;
    case "pending": return `${files(target.pendingTotal)} not uploaded.`;
    case "in-sync": return "The server matches the local copy.";
  }
}

export interface PendingGroups {
  /** New and changed files. */
  changed: PendingUploadRow[];
  /** Files deleted here that an upload deletes on the server: a group of their own, never left behind silently. */
  deleted: PendingUploadRow[];
}

export function groupPending(rows: readonly PendingUploadRow[]): PendingGroups {
  return { changed: rows.filter((row) => row.change !== "deleted"), deleted: rows.filter((row) => row.change === "deleted") };
}

/** The upload button's words: what goes up and what goes away, as the user decided. */
export function uploadSummary(rows: readonly PendingUploadRow[], chosen: (row: PendingUploadRow) => boolean = (row) => row.selected): string {
  const picked = rows.filter(chosen);
  const changed = picked.filter((row) => row.change !== "deleted").length;
  const deleted = picked.length - changed;
  if (picked.length === 0) return "Upload";
  return `Upload: ${[changed ? `${changed} changed` : "", deleted ? `${deleted} deleted` : ""].filter(Boolean).join(", ")}`;
}

/** "5 min ago", for a timestamp the view shows. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
