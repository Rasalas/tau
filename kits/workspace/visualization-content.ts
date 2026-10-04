import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, resolve, isAbsolute, sep } from "node:path";
import { isWorkspaceRelativePath } from "tau/host-extension";
import { assertWorkspacePath } from "./workspace-git.js";

export const MAX_VISUALIZATION_BYTES = 1024 * 1024;

/** Read only a bounded regular file inside the explicitly named workspace. */
export async function readVisualizationFragment(workspace: string, path: string): Promise<string> {
  if (!isWorkspaceRelativePath(path) || path.includes("\0")) throw new Error("Name a visualization by its path inside the workspace.");
  await assertWorkspacePath(workspace, path);
  const [root, target] = await Promise.all([realpath(workspace), realpath(resolve(workspace, path))]);
  const inside = relative(root, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Path is outside the workspace.");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Visualization must be a regular file.");
    if (info.size > MAX_VISUALIZATION_BYTES) throw new Error("Visualization fragment is too large.");
    const buffer = Buffer.alloc(MAX_VISUALIZATION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_VISUALIZATION_BYTES) throw new Error("Visualization fragment is too large.");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}
