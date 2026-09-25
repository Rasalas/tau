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

/** A test instance names its ssh config here; Tau then passes it to ssh as `-F`. */
export const SERVERS_SSH_CONFIG_ENV = "TAU_SERVERS_SSH_CONFIG";

/**
 * A test instance names a folder here: new server projects default to it, and
 * every local folder the project commands touch must lie inside it.
 */
export const SERVERS_PROJECTS_ROOT_ENV = "TAU_SERVERS_PROJECTS_ROOT";

/** What `projects-root` answers: the folder the guard holds new projects to, or null without one. */
export interface ProjectsRootState {
  root: string | null;
}

export interface ServerTargetIssue {
  code: string;
  level: "error" | "warning" | "info";
  message: string;
}

/** One target as Settings shows it: where the secrets come from, never their values. */
export interface ServerTargetRow {
  /** The key of the target's state folder. */
  id: string;
  /** The key of the profile choice: stable across profiles. */
  configKey: string;
  source: "sftp.json";
  label: string;
  /** Local folder relative to the project, `""` for the project itself. */
  context: string;
  profiles: string[];
  profile?: string;
  protocol: ServerProtocol;
  host: string;
  port: number;
  username?: string;
  remotePath: string;
  password: string;
  privateKeyPath?: string;
  passphrase?: string;
  issues: ServerTargetIssue[];
  usable: boolean;
}

/** `targets` answer: the main checkout, its sftp.json (absent when there is none) and what it names. */
export interface ServerTargetsState {
  workspace: string;
  file?: string;
  targets: ServerTargetRow[];
  issues: ServerTargetIssue[];
}

export interface SshHostsState {
  configPath: string;
  hosts: string[];
  problems: string[];
}

export function decodeServerTargetsState(value: unknown): ServerTargetsState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<ServerTargetsState>;
  if (typeof state.workspace !== "string" || !Array.isArray(state.targets) || !Array.isArray(state.issues)) return undefined;
  return state as ServerTargetsState;
}

/** Open questions of the host half (`{ prompts: ServerPrompt[] }`); the `prompts` command answers the same. */
export const SERVERS_PROMPTS_EVENT = "prompts";

/** A Tau dialog the host half asks. `secret` has a hidden field; `detail` is shown verbatim (a command). */
export interface ServerPromptRequest {
  kind: "confirm" | "secret";
  title: string;
  message: string;
  detail?: string;
  /** The hidden field's label, for `secret`. */
  field?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** A second way forward, such as "Try other items on this login". */
  alternativeLabel?: string;
}

export interface ServerPrompt extends ServerPromptRequest {
  id: string;
}

export type ServerPromptAnswer =
  | { action: "confirm"; value?: string }
  | { action: "alternative" }
  | { action: "cancel" };

export function decodeServerPrompts(value: unknown): ServerPrompt[] {
  const prompts = (value as { prompts?: unknown } | undefined)?.prompts;
  if (!Array.isArray(prompts)) return [];
  return prompts.filter((prompt): prompt is ServerPrompt => Boolean(prompt) && typeof (prompt as ServerPrompt).id === "string"
    && typeof (prompt as ServerPrompt).title === "string" && ((prompt as ServerPrompt).kind === "confirm" || (prompt as ServerPrompt).kind === "secret"));
}

export type SecretKind = "password" | "passphrase";

/** Where one secret of a target comes from and what Tau holds of it; never the value. */
export interface CredentialSecretStatus {
  /** Where Tau looks, in words. */
  source: string;
  /** Tau's own item exists (true), is absent (false) or the store cannot say without reading it (undefined). */
  saved?: boolean;
  /** Held in memory for this session. */
  session: boolean;
  /** A command from sftp.json (or a password manager's CLI) is involved: whether this project allowed it. */
  command?: "allowed" | "needs-approval";
  /** VS Code's item in the keychain: whether the user allowed Tau to read it. */
  foreignItem?: { label: string; allowed: boolean };
  /** Why Tau cannot use the store this target names here. */
  unavailable?: string;
}

export interface CredentialStatus {
  targetId: string;
  password: CredentialSecretStatus;
  passphrase?: CredentialSecretStatus;
}

export interface CredentialCheck {
  found: boolean;
  /** Where the secret came from, in words. */
  source?: string;
  message?: string;
}

/** `network` answer: the limit of the agent's commands in a server project, and what lifts it. */
export interface ServerNetworkState {
  /** An sftp.json or a target folder makes it one; only then does the limit hold. */
  serverProject: boolean;
  /** The user lifted the limit for this project. */
  allowAll: boolean;
  /** Hosts the user allowed beyond the package sources. */
  allowHosts: string[];
  /** Reachable without asking. */
  packageSources: string[];
  /** Whether Pi's commands can be held to the limit on this machine. */
  pi?: { available: boolean; reason?: string };
}

export function decodeServerNetworkState(value: unknown): ServerNetworkState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<ServerNetworkState>;
  if (typeof state.serverProject !== "boolean" || typeof state.allowAll !== "boolean" || !Array.isArray(state.allowHosts) || !Array.isArray(state.packageSources)) return undefined;
  return state as ServerNetworkState;
}
