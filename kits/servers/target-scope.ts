import { createHash } from "node:crypto";
import type { SftpJsonTarget } from "./sftp-json.js";

/** State belongs to a destination and local mapping, across all branches and worktrees. */
export function targetScope(target: SftpJsonTarget): string {
  const { protocol, secure, host, port, username, remotePath, context } = target;
  return createHash("sha256").update(JSON.stringify({ protocol, secure, host, port, username, remotePath, context })).digest("hex");
}
