import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/** Rejects traversal and symlink escapes before any path is passed to Git. */
export async function assertWorkspacePath(cwd: string, path: string): Promise<void> {
  const target = resolve(cwd, path);
  if (!within(cwd, target)) throw new Error("Path is outside the workspace.");
  const rootReal = await realpath(cwd);
  let probe = target;
  while (true) {
    try {
      if (!within(rootReal, await realpath(probe))) throw new Error("Path is outside the workspace.");
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "Path is outside the workspace.") throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A missing path is writable; an existing dangling link is not.
      const entry = await lstat(probe).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "ENOENT") throw failure;
        return undefined;
      });
      if (entry?.isSymbolicLink()) throw new Error("Path is outside the workspace.", { cause: error });
      if (probe === cwd) throw error;
      probe = dirname(probe);
    }
  }
}
