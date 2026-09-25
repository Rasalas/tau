import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCP_SOURCE = /^(?:[a-z0-9._-]+@)?[a-z0-9.-]+:[^\s]+$/iu;

/**
 * Tau only accepts network Git sources advertised by the project picker.
 * `TAU_TEST_CLONE_ROOT` (set by test instances and test hosts only) also lets
 * `file://` URLs through, and only for repositories inside that folder.
 */
export function assertAllowedCloneSource(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const source = input.trim();
  if (!source || source.includes("\0") || source.startsWith("-")) throw new Error("Enter a valid Git repository URL.");
  if (source.includes("://")) {
    try {
      const url = new URL(source);
      if ((url.protocol === "https:" || url.protocol === "ssh:") && url.hostname) return source;
      if (url.protocol === "file:" && isInsideTestCloneRoot(url, env.TAU_TEST_CLONE_ROOT)) return source;
    } catch {
      // Fall through to the stable user-facing error.
    }
  } else if (SCP_SOURCE.test(source)) {
    return source;
  }
  throw new Error("Use an HTTPS or SSH Git repository URL.");
}

function isInsideTestCloneRoot(url: URL, root: string | undefined): boolean {
  if (!root || !isAbsolute(root) || (url.hostname && url.hostname !== "localhost") || url.search || url.hash) return false;
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const inside = relative(real(root), real(fileURLToPath(url)));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}
