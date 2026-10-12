import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Git's checkout identity, read without starting a process or scanning status. */
export async function readRepositoryIdentity(cwd: string): Promise<{ gitDir: string; commonDir: string } | undefined> {
  // Explicit Git environment overrides need Git's own resolution rules.
  if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_CEILING_DIRECTORIES) return undefined;
  try {
    let directory = await realpath(cwd);
    for (;;) {
      const marker = join(directory, ".git");
      const info = await stat(marker).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info) {
        const target = info.isDirectory() ? marker : /^gitdir: (.+)\r?$/mu.exec(await readFile(marker, "utf8"))?.[1]?.trim();
        if (!target) return undefined;
        const gitDir = await realpath(resolve(directory, target));
        const common = await readFile(join(gitDir, "commondir"), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        const commonDir = common === undefined ? gitDir : await realpath(resolve(gitDir, common.trim()));
        return { gitDir, commonDir };
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    // Unusual layouts, missing metadata and bare repositories use Git's
    // existing resolver. A failed fast read must not invent an identity.
    return undefined;
  }
}
