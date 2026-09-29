import { readPersistedJson, writePersistedJson } from "./persisted-json.js";

/**
 * Leaf helpers for a runtime backend that drives a CLI the user installed:
 * the newest version npm publishes, and the command that updates an install
 * a package manager owns. Neither runs anything; both are read-only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

/**
 * `TAU_NO_RUNTIME_UPDATES=1`: nobody asks for newer releases, so nothing offers
 * an update. Test instances, smokes and benchmarks set it.
 */
export function runtimeUpdatesOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TAU_NO_RUNTIME_UPDATES === "1";
}

export interface NpmLatestVersionOptions {
  /** A JSON file of the caller's own, e.g. under `services.stateDir`. */
  cacheFile: string;
  /** How long an answer is kept; a day by default. */
  maxAgeMs?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?(): number;
  registry?: string;
  /** Read for `TAU_NO_RUNTIME_UPDATES`; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
}

interface CacheEntry { version: string; checkedAt: number }
type Cache = Record<string, CacheEntry>;

function decodeCache(value: unknown): Cache | undefined {
  const packages = (value as { packages?: unknown } | undefined)?.packages;
  if (!packages || typeof packages !== "object") return undefined;
  const cache: Cache = {};
  for (const [name, entry] of Object.entries(packages as Record<string, unknown>)) {
    const { version, checkedAt } = (entry ?? {}) as Partial<CacheEntry>;
    if (typeof version === "string" && typeof checkedAt === "number") cache[name] = { version, checkedAt };
  }
  return cache;
}

/**
 * The `latest` dist-tag of an npm package, asked of the registry at most once
 * per `maxAgeMs`. A failed request answers with the cached value, however old,
 * or `undefined`; it never throws. `undefined` without a request while
 * `TAU_NO_RUNTIME_UPDATES=1`.
 */
export async function npmLatestVersion(packageName: string, options: NpmLatestVersionOptions): Promise<string | undefined> {
  return cachedLatest(packageName, options, async (fetcher) => {
    const response = await fetcher(`${options.registry ?? "https://registry.npmjs.org"}/${packageName}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) return undefined;
    const version = (await response.json() as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  });
}

export type HomebrewKind = "formula" | "cask";

const HOMEBREW_NAME = /^[a-z0-9][a-z0-9@+._-]*$/u;

/**
 * The release `brew upgrade` delivers for a formula or cask, from Homebrew's
 * own JSON API, cached like `npmLatestVersion` (in the same file, under
 * `brew:<kind>:<name>`). A cask's build suffix after a comma is dropped.
 */
export async function homebrewLatestVersion(kind: HomebrewKind, name: string, options: NpmLatestVersionOptions & { api?: string }): Promise<string | undefined> {
  if (!HOMEBREW_NAME.test(name)) return undefined;
  return cachedLatest(`brew:${kind}:${name}`, options, async (fetcher) => {
    const response = await fetcher(`${options.api ?? "https://formulae.brew.sh/api"}/${kind}/${name}.json`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { version?: unknown; versions?: { stable?: unknown } };
    const version = kind === "cask" ? body.version : body.versions?.stable;
    return typeof version === "string" ? version.split(",")[0] : undefined;
  });
}

async function cachedLatest(key: string, options: NpmLatestVersionOptions, ask: (fetcher: typeof globalThis.fetch) => Promise<string | undefined>): Promise<string | undefined> {
  if (runtimeUpdatesOff(options.env)) return undefined;
  const now = options.now ?? Date.now;
  const cache = (await readPersistedJson(options.cacheFile, { expectedVersion: CACHE_VERSION, decode: decodeCache, logger: { warn: () => undefined } }).catch(() => undefined))?.data ?? {};
  const cached = cache[key];
  if (cached && now() - cached.checkedAt < (options.maxAgeMs ?? DAY_MS)) return cached.version;
  try {
    const version = (await ask(options.fetch ?? globalThis.fetch))?.trim();
    if (!version) return cached?.version;
    // Another kit may have written the file meanwhile; read it again so neither answer is lost.
    const fresh = (await readPersistedJson(options.cacheFile, { expectedVersion: CACHE_VERSION, decode: decodeCache, logger: { warn: () => undefined } }).catch(() => undefined))?.data ?? {};
    fresh[key] = { version, checkedAt: now() };
    await writePersistedJson(options.cacheFile, CACHE_VERSION, { packages: fresh }, { logger: { warn: () => undefined } }).catch(() => undefined);
    return version;
  } catch {
    return cached?.version;
  }
}

/**
 * The command that updates a CLI a package manager installed, read from the
 * resolved path of its executable: a Homebrew keg or cask, or an npm, pnpm
 * or bun global. `undefined` when no package manager owns the path, so the
 * caller names the program's own updater instead.
 */
export function packageUpdateCommand(realPath: string, npmPackage: string): string | undefined {
  const path = realPath.replaceAll("\\", "/");
  const brew = /\/(Cellar|Caskroom)\/([^/]+)\/[^/]+\//u.exec(path);
  if (brew) return brew[1] === "Caskroom" ? `brew upgrade --cask ${brew[2]}` : `brew upgrade ${brew[2]}`;
  const lower = path.toLowerCase();
  if (lower.includes("/.bun/")) return `bun add -g ${npmPackage}@latest`;
  if (lower.includes("/pnpm/")) return `pnpm add -g ${npmPackage}@latest`;
  if (lower.includes(`/node_modules/${npmPackage.toLowerCase()}/`)) return `npm install -g ${npmPackage}@latest`;
  return undefined;
}

/**
 * The command that installs one release of an npm-published CLI with the
 * package manager that owns the executable's resolved path: npm, pnpm or
 * bun. `undefined` for Homebrew and anything else, which cannot pin a release.
 */
export function packageInstallCommand(realPath: string, npmPackage: string, version: string): string | undefined {
  const path = realPath.replaceAll("\\", "/").toLowerCase();
  if (path.includes("/.bun/")) return `bun add -g ${npmPackage}@${version}`;
  if (path.includes("/pnpm/")) return `pnpm add -g ${npmPackage}@${version}`;
  if (path.includes(`/node_modules/${npmPackage.toLowerCase()}/`)) return `npm install -g ${npmPackage}@${version}`;
  return undefined;
}
