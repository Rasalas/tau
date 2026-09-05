import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { assertAllowedCloneSource } from "./clone-source.js";
import { readPersistedJson, writePersistedJson } from "./persisted-json.js";

/**
 * Where an extension package comes from, in Pi's own vocabulary: `npm:<spec>`,
 * `git:<url>` or a path on this machine. The list of sources a Tau installs
 * lives in `~/.tau/packages.json` (global) or `<project>/.tau/packages.json`
 * (project); npm and git sources resolve under `~/.tau/npm` and `~/.tau/git`.
 */
export type ExtensionSourceKind = "npm" | "git" | "path";

export interface ExtensionSource {
  kind: ExtensionSourceKind;
  /** The source as it is written in packages.json. */
  raw: string;
  /** npm: the package name without a version. git: the URL. path: the absolute path. */
  value: string;
  /** The version or range an npm source pinned, if any. */
  spec?: string;
}

export type PackageScope = "global" | "project";

export const PACKAGES_FILE = "packages.json";
const PACKAGES_FILE_VERSION = 1;

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

function parseNpmSource(raw: string, spec: string): ExtensionSource {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("An npm source needs a package name, e.g. npm:@acme/hello.");
  const at = trimmed.lastIndexOf("@");
  const name = at > 0 ? trimmed.slice(0, at) : trimmed;
  const version = at > 0 ? trimmed.slice(at + 1) : "";
  if (!NPM_NAME.test(name)) throw new Error(`"${name}" is not an npm package name.`);
  if (version.includes("/") || version.includes("\0")) throw new Error(`"${version}" is not an npm version.`);
  return { kind: "npm", raw, value: name, ...(version ? { spec: version } : {}) };
}

/**
 * Reads one source string. A path is resolved against `cwd`, so a project's
 * packages.json may name a folder beside it.
 */
export function parseExtensionSource(raw: string, cwd: string = process.cwd()): ExtensionSource {
  const source = raw.trim();
  if (!source || source.includes("\0")) throw new Error("Enter a source: npm:<package>, git:<url> or a folder path.");
  if (source.startsWith("npm:")) return parseNpmSource(source, source.slice(4));
  if (source.startsWith("git:")) {
    const url = assertAllowedCloneSource(source.slice(4));
    return { kind: "git", raw: `git:${url}`, value: url };
  }
  if (source.startsWith("-")) throw new Error("A folder path may not start with a dash.");
  const path = isAbsolute(source) ? resolve(source) : resolve(cwd, source);
  return { kind: "path", raw: source, value: path };
}

/** A folder name for a Git URL: its host and path, with everything else flattened. */
export function gitFolderName(url: string): string {
  const name = url
    .replace(/^[a-z+]+:\/\//iu, "")
    .replace(/^[^@/]+@/u, "")
    .replace(/\.git$/iu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/\.{2,}/gu, ".")
    .slice(0, 120);
  if (!name || name === "." || name.includes("..")) throw new Error(`"${url}" has no usable folder name.`);
  return name;
}

export function npmStoreDirectory(home: string = homedir()): string {
  return join(home, ".tau", "npm");
}

export function gitStoreDirectory(home: string = homedir()): string {
  return join(home, ".tau", "git");
}

/** Where a source's package folder is, once it is installed. */
export function sourceDirectory(source: ExtensionSource, home: string = homedir()): string {
  if (source.kind === "path") return source.value;
  const root = source.kind === "npm" ? join(npmStoreDirectory(home), "node_modules") : gitStoreDirectory(home);
  const name = source.kind === "npm" ? source.value : gitFolderName(source.value);
  const directory = resolve(root, name);
  // A crafted name must not reach out of the store; the parsers already
  // reject the shapes that could, this refuses whatever they missed.
  if (directory !== root && !directory.startsWith(resolve(root) + sep)) {
    throw new Error(`"${source.raw}" does not resolve inside ${root}.`);
  }
  return directory;
}

export function packagesFilePath(scope: PackageScope, cwd: string, home: string = homedir()): string {
  return scope === "global" ? join(home, ".tau", PACKAGES_FILE) : join(cwd, ".tau", PACKAGES_FILE);
}

export interface PackagesFile {
  sources: string[];
}

function decodePackagesFile(value: unknown): PackagesFile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const packages = (value as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return undefined;
  const sources = packages.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return { sources: [...new Set(sources.map((entry) => entry.trim()))] };
}

/** The sources one packages.json lists; a missing or unreadable file is an empty list. */
export async function readPackagesFile(path: string): Promise<PackagesFile> {
  const read = await readPersistedJson<PackagesFile>(path, {
    expectedVersion: PACKAGES_FILE_VERSION,
    decode: decodePackagesFile,
  });
  return read?.data ?? { sources: [] };
}

export async function writePackagesFile(path: string, file: PackagesFile): Promise<void> {
  await writePersistedJson(path, PACKAGES_FILE_VERSION, { packages: [...file.sources] });
}

/** Adds a source to a packages file; returns false when it was already listed. */
export async function addPackageSource(path: string, raw: string): Promise<boolean> {
  const file = await readPackagesFile(path);
  if (file.sources.includes(raw)) return false;
  await writePackagesFile(path, { sources: [...file.sources, raw] });
  return true;
}

/** Drops a source from a packages file; returns false when it was not listed. */
export async function removePackageSource(path: string, raw: string): Promise<boolean> {
  const file = await readPackagesFile(path);
  if (!file.sources.includes(raw)) return false;
  await writePackagesFile(path, { sources: file.sources.filter((entry) => entry !== raw) });
  return true;
}

export interface InstalledSource {
  scope: PackageScope;
  source: ExtensionSource;
  directory: string;
  /** Why the source could not be resolved to a folder, if it could not. */
  error?: string;
}

/** Every source both packages files list, resolved to the folder it installed into. */
export async function listInstalledSources(cwd: string, home: string = homedir()): Promise<InstalledSource[]> {
  const found: InstalledSource[] = [];
  for (const scope of ["global", "project"] as const) {
    const path = packagesFilePath(scope, cwd, home);
    const file = await readPackagesFile(path);
    for (const raw of file.sources) {
      try {
        const source = parseExtensionSource(raw, cwd);
        found.push({ scope, source, directory: sourceDirectory(source, home) });
      } catch (error) {
        found.push({
          scope,
          source: { kind: "path", raw, value: raw },
          directory: "",
          error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  return found;
}
