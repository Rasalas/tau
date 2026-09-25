// Shared by both halves; no imports, so any side may read it.

export const SERVERS_EXTENSION_ID = "tau.servers";

/** How Tau reaches a server target. FTP covers FTPS through the target's `secure` option. */
export type ServerProtocol = "sftp" | "ftp";
export const SERVER_PROTOCOLS: readonly ServerProtocol[] = ["sftp", "ftp"];

/**
 * What the agent may do on a target without asking (ADR 0028). Reading is always free;
 * writing Git on the server is refused at every level.
 */
export type TargetLevel = "read-only" | "ask" | "full";
export const TARGET_LEVELS: readonly TargetLevel[] = ["read-only", "ask", "full"];
export const DEFAULT_TARGET_LEVEL: TargetLevel = "ask";

/** What a transport offers beyond reading and writing files; the UI hides what a target lacks. */
export interface ServerCapabilities {
  exec: boolean;
  hash: boolean;
  atomicRename: boolean;
  chmod: boolean;
  mtimeSet: boolean;
}

/** `committed` once HEAD holds every file of the deployment; `rolled-back` once undone. */
export type DeploymentStatus = "uploaded" | "verified" | "committed" | "rolled-back";

/**
 * The kit's settings are this machine's only: a project level would mean a
 * `.tau/config.json` in the project, which server projects must not get.
 */
export const SERVERS_SETTINGS_SCOPE = "host" as const;
/** `values.tau.servers.<key>`. */
export const RETENTION_DAYS_KEY = "retentionDays";
export const RETENTION_COUNT_KEY = "retentionCount";
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_RETENTION_COUNT = 200;

export function readTargetLevel(value: unknown): TargetLevel {
  return typeof value === "string" && (TARGET_LEVELS as readonly string[]).includes(value) ? value as TargetLevel : DEFAULT_TARGET_LEVEL;
}
