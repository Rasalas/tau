import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { CookieImportSource } from "./protocol.js";

/**
 * The directories browser paths are built from. Passed in rather than read
 * from `process`, so a test (or an isolated instance) points them at fixtures.
 */
export interface BrowserPaths {
  platform: NodeJS.Platform;
  home: string;
  /** `%APPDATA%`, Windows only. */
  appData?: string;
}

export type CookieEngine = CookieImportSource["engine"];

export interface BrowserDefinition {
  id: string;
  name: string;
  engine: CookieEngine;
  root(paths: BrowserPaths): string | undefined;
  /** macOS keychain item that holds a Chromium browser's cookie secret. */
  keychain?: { service: string; account: string };
}

/** A profile the source listed; `path` is where its cookie store lives. */
export interface BrowserProfile {
  id: string;
  name: string;
  path: string;
}

const macSupport = (paths: BrowserPaths, ...segments: string[]) => join(paths.home, "Library", "Application Support", ...segments);

/**
 * A Chromium fork: its folder on macOS and Linux and its keychain item. None is
 * importable on Windows, where cookies are bound to the browser's own identity.
 */
function chromium(id: string, name: string, service: string, account: string, mac: string[], linux?: string[]): BrowserDefinition {
  return {
    id,
    name,
    engine: "chromium",
    keychain: { service, account },
    root: (paths) => {
      if (paths.platform === "darwin") return macSupport(paths, ...mac);
      if (paths.platform === "linux" && linux) return join(paths.home, ".config", ...linux);
      return undefined;
    },
  };
}

export const BROWSER_SOURCES: readonly BrowserDefinition[] = [
  chromium("chrome", "Chrome", "Chrome Safe Storage", "Chrome", ["Google", "Chrome"], ["google-chrome"]),
  chromium("arc", "Arc", "Arc Safe Storage", "Arc", ["Arc", "User Data"]),
  chromium("brave", "Brave", "Brave Safe Storage", "Brave", ["BraveSoftware", "Brave-Browser"], ["BraveSoftware", "Brave-Browser"]),
  chromium("edge", "Microsoft Edge", "Microsoft Edge Safe Storage", "Microsoft Edge", ["Microsoft Edge"], ["microsoft-edge"]),
  chromium("vivaldi", "Vivaldi", "Vivaldi Safe Storage", "Vivaldi", ["Vivaldi"], ["vivaldi"]),
  chromium("chromium", "Chromium", "Chromium Safe Storage", "Chromium", ["Chromium"], ["chromium"]),
  {
    id: "firefox",
    name: "Firefox",
    engine: "firefox",
    root: (paths) => {
      if (paths.platform === "darwin") return macSupport(paths, "Firefox");
      if (paths.platform === "win32") return paths.appData ? join(paths.appData, "Mozilla", "Firefox") : undefined;
      return join(paths.home, ".mozilla", "firefox");
    },
  },
  {
    id: "safari",
    name: "Safari",
    engine: "safari",
    root: (paths) => paths.platform === "darwin"
      ? join(paths.home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies")
      : undefined,
  },
];

const isFile = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile(), () => false);

/** Chromium 96 moved the store into `Network/`; an older one keeps it beside the profile. */
export async function cookieStorePath(engine: CookieEngine, profileDirectory: string): Promise<string | undefined> {
  const candidates = engine === "chromium" ? [join(profileDirectory, "Network", "Cookies"), join(profileDirectory, "Cookies")]
    : engine === "firefox" ? [join(profileDirectory, "cookies.sqlite")]
      : [join(profileDirectory, "Cookies.binarycookies")];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

/** One plain folder name: a listed profile can never walk out of the browser's folder. */
const plainSegment = (name: string): boolean => name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/u.test(name);

async function chromiumProfiles(root: string): Promise<BrowserProfile[]> {
  const declared: Array<{ id: string; name: string }> = [];
  try {
    const state = JSON.parse(await readFile(join(root, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: unknown }> } };
    for (const [id, info] of Object.entries(state.profile?.info_cache ?? {})) {
      if (plainSegment(id)) declared.push({ id, name: typeof info?.name === "string" && info.name.trim() ? info.name.trim() : id });
    }
  } catch {
    // No readable Local State: the folders themselves say which profiles exist.
  }
  if (declared.length === 0) {
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const id of entries.sort()) if (id === "Default" || /^Profile \d+$/u.test(id)) declared.push({ id, name: id });
  }
  return withStores("chromium", declared.map((profile) => ({ ...profile, path: join(root, profile.id) })));
}

/** `[ProfileN]` blocks of Firefox's `profiles.ini`; a relative path may not leave the root. */
export function parseFirefoxProfiles(ini: string, root: string): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];
  let current: Record<string, string> | undefined;
  const flush = () => {
    const path = current?.path;
    if (current && path && !path.includes("\0")) {
      const relativePath = current.isrelative !== "0";
      if (relativePath && !isAbsolute(path)) {
        const inside = relative(root, resolve(root, path));
        if (inside && !inside.startsWith("..") && !isAbsolute(inside)) profiles.push({ id: normalize(path), name: current.name?.trim() || path, path: resolve(root, path) });
      } else if (!relativePath && isAbsolute(path)) {
        profiles.push({ id: normalize(path), name: current.name?.trim() || path, path: normalize(path) });
      }
    }
    current = undefined;
  };
  for (const raw of ini.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      flush();
      current = /^\[Profile\d+\]$/iu.test(line) ? {} : undefined;
      continue;
    }
    const at = line.indexOf("=");
    if (current && at > 0) current[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  flush();
  return profiles;
}

async function firefoxProfiles(root: string): Promise<BrowserProfile[]> {
  const declared = await readFile(join(root, "profiles.ini"), "utf8").then((ini) => parseFirefoxProfiles(ini, root), () => []);
  const found = await withStores("firefox", declared);
  if (found.length > 0) return found;
  const folder = join(root, "Profiles");
  const entries = await readdir(folder).catch(() => [] as string[]);
  return withStores("firefox", entries.filter(plainSegment).sort().map((entry) => ({ id: join("Profiles", entry), name: entry, path: join(folder, entry) })));
}

async function withStores(engine: CookieEngine, profiles: BrowserProfile[]): Promise<BrowserProfile[]> {
  const checked = await Promise.all(profiles.map(async (profile) => await cookieStorePath(engine, profile.path) ? profile : undefined));
  return checked.filter((profile): profile is BrowserProfile => profile !== undefined);
}

/** The profiles of one browser that hold a cookie store; none when it is not installed. */
export async function listBrowserProfiles(definition: BrowserDefinition, paths: BrowserPaths): Promise<BrowserProfile[]> {
  const root = definition.root(paths);
  if (!root) return [];
  if (definition.engine === "chromium") return chromiumProfiles(root);
  if (definition.engine === "firefox") return firefoxProfiles(root);
  // Safari's named profiles keep separate stores; only the default one is read.
  return withStores("safari", [{ id: "default", name: "Safari", path: root }]);
}

/** Installed browsers with at least one profile. Reads folder names and profile lists, no cookie. */
export async function listCookieSources(paths: BrowserPaths): Promise<CookieImportSource[]> {
  const listed = await Promise.all(BROWSER_SOURCES.map(async (definition) => {
    const profiles = await listBrowserProfiles(definition, paths);
    if (profiles.length === 0) return undefined;
    const source: CookieImportSource = { id: definition.id, name: definition.name, engine: definition.engine, profiles: profiles.map(({ id, name }) => ({ id, name })) };
    if (definition.keychain && paths.platform === "darwin") source.keychain = definition.keychain.service;
    return source;
  }));
  return listed.filter((source): source is CookieImportSource => source !== undefined);
}

/**
 * The store of a profile the source lists right now. The id arrives from the
 * window, so it counts only when the listing still names it.
 */
export async function resolveBrowserProfile(sourceId: unknown, profileId: unknown, paths: BrowserPaths): Promise<{ definition: BrowserDefinition; profile: BrowserProfile; store: string } | { failure: "unknown-source" | "unknown-profile" }> {
  const definition = BROWSER_SOURCES.find((candidate) => candidate.id === sourceId);
  if (!definition) return { failure: "unknown-source" };
  const profile = (await listBrowserProfiles(definition, paths)).find((candidate) => candidate.id === profileId);
  const store = profile ? await cookieStorePath(definition.engine, profile.path) : undefined;
  if (!profile || !store) return { failure: "unknown-profile" };
  return { definition, profile, store };
}
