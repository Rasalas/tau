import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, sep } from "node:path";

const ARCHIVE = `${sep}app.asar${sep}`;
const UNPACKED = `${sep}app.asar.unpacked${sep}`;

/**
 * The path a file really has on disk. Electron reads inside `app.asar` through
 * its own patched `fs`, but a process it spawns and a worker thread it starts
 * open the file for themselves and see no archive, so those two need the copy
 * `asarUnpack` left beside it. Outside a packaged app this changes nothing.
 */
export function unpackedPath(path: string): string {
  return path.includes(ARCHIVE) ? path.replace(ARCHIVE, UNPACKED) : path;
}

/**
 * The version in the app's `package.json`. A packaged host runs from
 * `app.asar.unpacked`, but `package.json` stays in `app.asar` beside it.
 */
export function appPackageVersion(appRoot: string): string | undefined {
  const candidates = [join(appRoot, "package.json")];
  if (basename(appRoot) === "app.asar.unpacked") candidates.push(join(dirname(appRoot), "app.asar", "package.json"));
  for (const file of candidates) {
    try {
      const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
      if (typeof version === "string" && version) return version;
    } catch {
      // Not there, or not readable: try the next place.
    }
  }
  return undefined;
}

/** Whether this module is running from inside the archive of an installed Tau. */
export function insideArchive(moduleUrl = import.meta.url): boolean {
  return moduleUrl.includes("/app.asar/");
}

/**
 * esbuild's native binary, as a path that can be spawned. esbuild finds it with
 * `require.resolve`, which answers with the archive path even for a file that
 * ships unpacked, and spawning that fails with ENOTDIR. This resolves the same
 * platform package from esbuild's own folder: the packaged tree can also hold
 * another esbuild's binary (a dependency's) under a top-level `@esbuild`.
 */
export function esbuildBinaryPath(from: string = import.meta.url, target = `${process.platform}-${process.arch}`): string | undefined {
  const subpath = target.startsWith("win32-") ? "esbuild.exe" : "bin/esbuild";
  try {
    const esbuild = createRequire(from).resolve("esbuild");
    const file = unpackedPath(createRequire(esbuild).resolve(`@esbuild/${target}/${subpath}`));
    return existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Points esbuild at the binary beside the archive, and answers with the path it
 * chose. esbuild reads `ESBUILD_BINARY_PATH` once, while its own module is
 * being evaluated, so this has to run before any import of it — which is why
 * every module that imports esbuild imports this one on the line above.
 */
export function useUnpackedEsbuildBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ESBUILD_BINARY_PATH) return env.ESBUILD_BINARY_PATH;
  if (!insideArchive()) return undefined;
  const binary = esbuildBinaryPath();
  if (binary) env.ESBUILD_BINARY_PATH = binary;
  return binary;
}

useUnpackedEsbuildBinary();
