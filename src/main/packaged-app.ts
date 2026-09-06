import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

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

/** Whether this module is running from inside the archive of an installed Tau. */
export function insideArchive(moduleUrl = import.meta.url): boolean {
  return moduleUrl.includes("/app.asar/");
}

/**
 * esbuild's native binary, as a path that can be spawned. esbuild finds it with
 * `require.resolve`, which answers with the archive path even for a file that
 * ships unpacked, and spawning that fails with ENOTDIR. Its platform package is
 * the only entry under `@esbuild`, so the layout does not have to be repeated
 * here — only the two names esbuild gives the binary.
 */
export function esbuildBinaryPath(resolveFrom: (specifier: string) => string = createRequire(import.meta.url).resolve): string | undefined {
  let scoped: string;
  try {
    // <node_modules>/esbuild/lib/main.js -> <node_modules>/@esbuild
    scoped = join(dirname(dirname(dirname(resolveFrom("esbuild")))), "@esbuild");
  } catch {
    return undefined;
  }
  const directory = unpackedPath(scoped);
  let platforms: string[];
  try {
    platforms = readdirSync(directory);
  } catch {
    return undefined;
  }
  for (const platform of platforms.sort()) {
    for (const subpath of [join("bin", "esbuild"), "esbuild.exe"]) {
      const file = join(directory, platform, subpath);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
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
