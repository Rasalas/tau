import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CookieImportResult, CookieImportSite, CookieImportSource } from "./protocol.js";
import { fixtureKeyProvider, keychainKeyProvider, type CookieKeyProvider } from "./cookie-keys.js";
import {
  CookieImportError,
  LINUX_FALLBACK_SECRET,
  bareHost,
  chromiumKey,
  cookieToWrite,
  decryptChromium,
  readStore,
  siteOf,
  sitesOf,
  type ChromiumKeys,
  type CookieToWrite,
} from "./cookie-read.js";
import { listCookieSources, resolveBrowserProfile, type BrowserPaths } from "./cookie-sources.js";

/** The part of Electron's `session.cookies` an import writes through. */
export interface CookieJar {
  set(cookie: CookieToWrite): Promise<void>;
  flushStore(): Promise<void>;
}

export interface CookieImportEnvironment {
  paths: BrowserPaths;
  keys: CookieKeyProvider;
  jar(partition: string): CookieJar;
  now?(): number;
}

/** Only Preview's own partitions; the workbench's session is never written. */
const PREVIEW_PARTITION = /^persist:tau-preview(?:-[a-z0-9-]{1,32})?$/u;
const MAX_SITES = 500;
const SKIPPED_SHOWN = 20;

/** Set by `dev-instance`: browsers are then read from `<root>/browsers`, with a fixture keychain. */
const IMPORT_ROOTS_VARIABLE = "TAU_IMPORT_ROOTS";

/**
 * The machine's own browsers and keychain, or, when an isolated instance names
 * fixture roots, a stand-in home and keychain under the first of them.
 */
export function cookieImportEnvironment(jar: CookieImportEnvironment["jar"], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CookieImportEnvironment {
  const root = env[IMPORT_ROOTS_VARIABLE]?.split(delimiter).find(Boolean);
  if (root) {
    const home = join(root, "browsers");
    return { paths: { platform, home, appData: join(home, "AppData", "Roaming") }, keys: fixtureKeyProvider(home), jar };
  }
  return { paths: { platform, home: homedir(), ...(env.APPDATA ? { appData: env.APPDATA } : {}) }, keys: keychainKeyProvider, jar };
}

const fields = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

async function resolve(input: unknown, paths: BrowserPaths) {
  const request = fields(input);
  const found = await resolveBrowserProfile(request.source, request.profile, paths);
  if ("failure" in found) {
    throw found.failure === "unknown-source"
      ? new CookieImportError("unknown-source", "Tau does not know that browser.")
      : new CookieImportError("unknown-profile", "That browser profile is gone. Choose another one.");
  }
  return found;
}

export async function listSources(environment: CookieImportEnvironment): Promise<CookieImportSource[]> {
  return listCookieSources(environment.paths);
}

/** Site names and counts; nothing is decrypted and no key is asked for. */
export async function listSites(input: unknown, environment: CookieImportEnvironment): Promise<CookieImportSite[]> {
  const { definition, store } = await resolve(input, environment.paths);
  return sitesOf((await readStore(definition.engine, store)).cookies);
}

/**
 * Copies the chosen sites' cookies into one Preview partition. Only cookies of
 * those sites are decrypted, and the key is asked for only when one of them
 * is encrypted. Values go straight into the session; none is returned.
 */
export async function importCookies(input: unknown, environment: CookieImportEnvironment): Promise<Omit<CookieImportResult, "profile" | "reloaded">> {
  const request = fields(input);
  const partition = typeof request.partition === "string" ? request.partition : "";
  if (!PREVIEW_PARTITION.test(partition)) throw new CookieImportError("unknown-profile", "Cookies can only go into a Preview profile.");
  const sites = new Set(Array.isArray(request.sites) ? request.sites.filter((site): site is string => typeof site === "string").slice(0, MAX_SITES) : []);
  if (sites.size === 0) return { imported: 0, skipped: 0, skippedSites: [] };
  const { definition, store } = await resolve(input, environment.paths);
  const read = await readStore(definition.engine, store);
  const now = (environment.now ?? Date.now)() / 1000;
  // An expired cookie signs nobody in; it is left behind rather than counted.
  const chosen = read.cookies.filter((cookie) => sites.has(siteOf(cookie.host)) && (cookie.expires === undefined || cookie.expires > now));
  const skippedSites = new Set(read.unreadable.map(siteOf).filter((site) => sites.has(site)));
  let skipped = read.unreadable.filter((host) => sites.has(siteOf(host))).length;

  let keys: ChromiumKeys = {};
  if (definition.engine === "chromium" && chosen.some((cookie) => cookie.encrypted)) {
    const { platform } = environment.paths;
    if (platform === "darwin" && definition.keychain) keys = { v10: chromiumKey(await environment.keys.secret(definition.keychain), platform) };
    // Linux `v11` needs the desktop keyring, which Tau does not ask; those cookies are skipped.
    else if (platform === "linux") keys = { v10: chromiumKey(LINUX_FALLBACK_SECRET, platform) };
  }

  const jar = environment.jar(partition);
  let imported = 0;
  // One at a time: the store serialises writes anyway, and a refused cookie costs only itself.
  for (const cookie of chosen) {
    const value = cookie.encrypted ? decryptChromium(cookie.encrypted, cookie.host, keys, read.schema) : cookie.value ?? "";
    const written = value === undefined ? false : await jar.set(cookieToWrite(cookie, value)).then(() => true, () => false);
    if (written) imported += 1;
    else {
      skipped += 1;
      skippedSites.add(siteOf(bareHost(cookie.host)));
    }
  }
  // `set` lands in memory; flushing first means "done" survives a crash right after.
  if (imported > 0) await jar.flushStore().catch(() => undefined);
  return { imported, skipped, skippedSites: [...skippedSites].sort().slice(0, SKIPPED_SHOWN) };
}

/** The window half's `cookie-*` commands, in the process that owns the browser sessions. */
export function runCookieImportCommand(command: string, input: unknown, environment: CookieImportEnvironment): Promise<unknown> {
  switch (command) {
    case "sources": return listSources(environment);
    case "sites": return listSites(input, environment);
    case "import": return importCookies(input, environment);
    default: return Promise.reject(new Error(`Cookie import has no command "${command}".`));
  }
}
