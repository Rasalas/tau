/**
 * How a client names a workspace. `workspaceId` is opaque: a client stores it,
 * sends it back, and never parses or composes it. Only the host knows which
 * directory it stands for, so a client on another machine never handles a path
 * of that machine as if it were one of its own.
 */
export interface WorkspaceRef {
  workspaceId: string;
  /** For the user's eyes only: an absolute path on a local host, never an address. */
  displayPath: string;
}

/** Marks the encoding, so a host can tell an id from a path a legacy client sent. */
export const WORKSPACE_ID_PREFIX = "ws1_";

export function isWorkspaceId(value: string): boolean {
  return value.startsWith(WORKSPACE_ID_PREFIX);
}

/**
 * A file inside a workspace travels as a POSIX path relative to its root.
 * Absolute paths and `..` escapes are refused before the host resolves them.
 */
export function isWorkspaceRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("\\") || /^[a-z]:/iu.test(value)) return false;
  return !value.split("/").some((segment) => segment === ".." || segment === "");
}
