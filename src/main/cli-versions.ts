import { readPersistedJson, writePersistedJson } from "./persisted-json.js";

/**
 * Leaf helpers for a runtime backend that drives a CLI the user installed:
 * the newest version npm publishes, and the command that updates an install
 * a package manager owns. Neither runs anything; both are read-only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

export interface NpmLatestVersionOptions {
  /** A JSON file of the caller's own, e.g. under `services.stateDir`. */
  cacheFile: string;
  /** How long an answer is kept; a day by default. */
  maxAgeMs?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?(): number;
  registry?: string;
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
 * or `undefined`; it never throws.
 */
export async function npmLatestVersion(packageName: string, options: NpmLatestVersionOptions): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const cache = (await readPersistedJson(options.cacheFile, { expectedVersion: CACHE_VERSION, decode: decodeCache, logger: { warn: () => undefined } }).catch(() => undefined))?.data ?? {};
  const cached = cache[packageName];
  if (cached && now() - cached.checkedAt < (options.maxAgeMs ?? DAY_MS)) return cached.version;
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetcher(`${options.registry ?? "https://registry.npmjs.org"}/${packageName}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) return cached?.version;
    const version = (await response.json() as { version?: unknown }).version;
    if (typeof version !== "string" || !version.trim()) return cached?.version;
    cache[packageName] = { version: version.trim(), checkedAt: now() };
    await writePersistedJson(options.cacheFile, CACHE_VERSION, { packages: cache }, { logger: { warn: () => undefined } }).catch(() => undefined);
    return version.trim();
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
