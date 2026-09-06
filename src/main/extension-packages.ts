// esbuild reads ESBUILD_BINARY_PATH while it loads, so this import comes first.
import { unpackedPath } from "./packaged-app.js";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { HostExtension } from "./host-extensions.js";
import type { ExtensionInspection } from "../shared/contracts.js";
import { assertEngineRanges, describeIncompatibility, parseVersion, type ExtensionEngines, type ExtensionHostVersions } from "../shared/extension-compat.js";
import { DEFAULT_PACKAGE_ISOLATION, isExtensionIsolation, isExtensionPermission, type ExtensionIsolation } from "../shared/extension-permissions.js";
import { createWorkerHostExtension, type WorkerHostExtensionOptions } from "./host-extension-isolation.js";
import { isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import { listInstalledSources } from "./extension-sources.js";
import { describeSignature, readTrustedPublishers, verifyExtensionSignature, type SignatureState, type TrustedPublisher } from "./extension-signature.js";

export const MANIFEST_FILE = "tau-extension.json";
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const ENGINE_NAMES = ["tau", "pi", "api"] as const;

/**
 * `tau-extension.json` in a package folder under `~/.tau/extensions` or
 * `<project>/.tau/extensions`. The desktop entry is loaded by the renderer,
 * the host entry by the Electron main process; both halves share the id.
 */
export interface ExtensionManifest {
  id: string;
  name: string;
  /** The package's own version, semver. */
  version?: string;
  /** Ranges of Tau, Pi and the extension API the package runs on; a miss keeps it off. */
  engines?: ExtensionEngines;
  /** Permissions the package requests from the host. Missing means []. */
  permissions?: string[];
  /** Where the host half runs. Missing means "worker"; "in-process" is granted like a permission. */
  isolation?: ExtensionIsolation;
  /** Upstream source repository and commit for provenance. */
  source?: { url: string; commit?: string };
  /** Relative path of the desktop entry (a module default-exporting a DesktopExtension). */
  desktop?: string;
  /** Relative path of the host entry (a module default-exporting a HostExtension or `activate`). */
  host?: string;
  /** Relative path of the Pi entry: the package's half inside a Pi runtime Tau does not own. */
  pi?: string;
}

export interface ExtensionPackage {
  scope: "global" | "project";
  directory: string;
  manifest: ExtensionManifest;
  desktopEntry?: string;
  hostEntry?: string;
  piEntry?: string;
  /** The source string `packages.json` lists, for a package the installer put there. */
  installedFrom?: string;
  /** What `tau-extension.sig` proved; a package that fails its own hashes never gets here. */
  signature?: SignatureState;
}

export function extensionPackageDirectories(cwd: string, home = homedir()): Array<{ scope: "global" | "project"; directory: string }> {
  return [
    { scope: "global", directory: join(home, ".tau", "extensions") },
    { scope: "project", directory: join(cwd, ".tau", "extensions") },
  ];
}

function relativeEntry(directory: string, value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${key}" must be a relative path`);
  if (isAbsolute(value)) throw new Error(`"${key}" must be relative to the package folder`);
  const path = resolve(directory, value);
  if (!path.startsWith(resolve(directory) + "/")) throw new Error(`"${key}" must stay inside the package folder`);
  return path;
}

function parsePermissions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`"permissions" must be an array of strings`);
  for (const item of value) {
    if (typeof item !== "string" || !isExtensionPermission(item)) {
      throw new Error(`unknown permission "${String(item)}"`);
    }
  }
  return [...new Set(value as string[])].sort();
}

function parseIsolation(value: unknown): ExtensionIsolation | undefined {
  if (value === undefined) return undefined;
  if (!isExtensionIsolation(value)) throw new Error(`"isolation" is "worker" or "in-process", not "${String(value)}"`);
  return value;
}

function parseSource(value: unknown): { url: string; commit?: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`"source" must be an object`);
  const { url, commit } = value as Record<string, unknown>;
  if (typeof url !== "string" || !url.trim()) throw new Error(`"source.url" must be a non-empty string`);
  if (commit !== undefined && (typeof commit !== "string" || !commit.trim())) {
    throw new Error(`"source.commit" must be a non-empty string`);
  }
  return {
    url: url.trim(),
    ...(typeof commit === "string" && commit.trim() ? { commit: commit.trim() } : {}),
  };
}

/** Parses and validates one manifest; entries are resolved but not read. */
export function parseExtensionManifest(directory: string, source: string): { manifest: ExtensionManifest; desktopEntry?: string; hostEntry?: string; piEntry?: string } {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error(`${MANIFEST_FILE} is not valid JSON`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MANIFEST_FILE} must be an object`);
  const { id, name, version, engines, permissions, isolation, source: manifestSource, desktop, host, pi } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !EXTENSION_ID.test(id)) throw new Error(`"id" must look like "vendor.name" (lowercase letters, digits, dashes, dots)`);
  if (typeof name !== "string" || !name.trim()) throw new Error(`"name" must be a non-empty string`);
  if (version !== undefined && (typeof version !== "string" || !parseVersion(version))) throw new Error(`"version" must be a semver string like "1.2.0"`);
  const parsedEngines = parseEngines(engines);
  const parsedPermissions = parsePermissions(permissions);
  const parsedIsolation = parseIsolation(isolation);
  const parsedSource = parseSource(manifestSource);
  const desktopEntry = relativeEntry(directory, desktop, "desktop");
  const hostEntry = relativeEntry(directory, host, "host");
  const piEntry = relativeEntry(directory, pi, "pi");
  if (!desktopEntry && !hostEntry) throw new Error(`${MANIFEST_FILE} names neither a "desktop" nor a "host" entry`);
  return {
    manifest: {
      id,
      name: name.trim(),
      ...(typeof version === "string" ? { version: version.trim() } : {}),
      ...(parsedEngines ? { engines: parsedEngines } : {}),
      permissions: parsedPermissions,
      ...(parsedIsolation ? { isolation: parsedIsolation } : {}),
      ...(parsedSource ? { source: parsedSource } : {}),
      ...(typeof desktop === "string" ? { desktop } : {}),
      ...(typeof host === "string" ? { host } : {}),
      ...(typeof pi === "string" ? { pi } : {}),
    },
    ...(desktopEntry ? { desktopEntry } : {}),
    ...(hostEntry ? { hostEntry } : {}),
    ...(piEntry ? { piEntry } : {}),
  };
}

function parseEngines(value: unknown): ExtensionEngines | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`"engines" must be an object with "tau", "pi" or "api" ranges`);
  const engines: ExtensionEngines = {};
  for (const [engine, range] of Object.entries(value as Record<string, unknown>)) {
    if (!(ENGINE_NAMES as readonly string[]).includes(engine)) throw new Error(`"engines" knows only ${ENGINE_NAMES.map((e) => `"${e}"`).join(", ")}, not "${engine}"`);
    if (typeof range !== "string" || !range.trim()) throw new Error(`"engines.${engine}" must be a version range like "^1.0.0"`);
    engines[engine as keyof ExtensionEngines] = range.trim();
  }
  try { assertEngineRanges(engines); } catch (error) { throw new Error(`"engines": ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  return engines;
}

/** Where a package's host half runs; a package that declares nothing is isolated. */
export function packageIsolation(manifest: { isolation?: ExtensionIsolation }): ExtensionIsolation {
  return manifest.isolation ?? DEFAULT_PACKAGE_ISOLATION;
}

/** Why a manifest cannot run on these versions, or undefined when it can. */
export function manifestIncompatibility(manifest: ExtensionManifest, versions: ExtensionHostVersions | undefined): string | undefined {
  if (!versions) return undefined;
  const reason = describeIncompatibility(manifest.engines, versions);
  return reason ? `${manifest.id}${manifest.version ? ` ${manifest.version}` : ""} ${reason}` : undefined;
}

export interface PackageScanResult {
  packages: ExtensionPackage[];
  errors: Array<{ path: string; message: string }>;
  skipped: Array<{ directory: string; reason: string }>;
}

export interface PackageScanOptions {
  home?: string;
  trusted?: (cwd: string) => boolean;
  /** Versions to check `engines` against; without them every package passes. */
  versions?: ExtensionHostVersions;
  /** Where the Ed25519 keys a signature may be trusted against live. */
  publishersFilePath?: string;
}

/** Reads one package folder, engines and signature included. */
async function readPackageFolder(
  scope: "global" | "project",
  packageDir: string,
  options: PackageScanOptions,
  publishers: readonly TrustedPublisher[],
): Promise<ExtensionPackage> {
  const parsed = parseExtensionManifest(packageDir, await readFile(join(packageDir, MANIFEST_FILE), "utf8"));
  const incompatible = manifestIncompatibility(parsed.manifest, options.versions);
  if (incompatible) throw new Error(incompatible);
  for (const entry of [parsed.desktopEntry, parsed.hostEntry, parsed.piEntry]) {
    if (entry && !await stat(entry).then((s) => s.isFile()).catch(() => false)) throw new Error(`entry ${entry} does not exist`);
  }
  const signature = await verifyExtensionSignature(packageDir, parsed.manifest, publishers);
  // A hash that no longer matches means the folder changed after it was signed:
  // that is a broken package, not a weaker one, so it does not load at all.
  if (signature.state === "tampered") throw new Error(describeSignature(signature));
  return { scope, directory: packageDir, ...parsed, signature };
}

/** Every package folder with a manifest; project folders only where Pi trusts the project. */
export async function listExtensionPackages(
  cwd: string,
  agentDir: string,
  options: PackageScanOptions = {},
): Promise<PackageScanResult> {
  const trusted = options.trusted ?? ((path: string) => new ProjectTrustStore(agentDir).get(path) === true);
  const home = options.home ?? homedir();
  const publishers = await readTrustedPublishers(options.publishersFilePath ?? undefined);
  const result: PackageScanResult = { packages: [], errors: [], skipped: [] };
  const seen = new Set<string>();
  for (const { scope, directory } of extensionPackageDirectories(cwd, home)) {
    let names: string[];
    try { names = await readdir(directory); } catch { continue; }
    const found: ExtensionPackage[] = [];
    for (const name of names.sort()) {
      if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
      const packageDir = join(directory, name);
      const manifestPath = join(packageDir, MANIFEST_FILE);
      const info = await stat(manifestPath).catch(() => undefined);
      if (!info?.isFile()) continue;
      try {
        found.push(await readPackageFolder(scope, packageDir, options, publishers));
      } catch (error) {
        result.errors.push({ path: manifestPath, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (found.length === 0) continue;
    if (scope === "project" && !trusted(cwd)) {
      result.skipped.push({ directory, reason: "The project is not trusted in Pi, so its extension packages stay off." });
      continue;
    }
    for (const pkg of found) {
      if (seen.has(pkg.directory)) continue;
      seen.add(pkg.directory);
      result.packages.push(pkg);
    }
  }
  await addInstalledSources(cwd, home, options, publishers, trusted, result, seen);
  return result;
}

/** Adds the packages `packages.json` names, wherever the installer put them. */
async function addInstalledSources(
  cwd: string,
  home: string,
  options: PackageScanOptions,
  publishers: readonly TrustedPublisher[],
  trusted: (cwd: string) => boolean,
  result: PackageScanResult,
  seen: Set<string>,
): Promise<void> {
  const installed = await listInstalledSources(cwd, home);
  let projectSkipped = false;
  for (const entry of installed) {
    if (entry.error) {
      result.errors.push({ path: entry.source.raw, message: entry.error });
      continue;
    }
    if (entry.scope === "project" && !trusted(cwd)) {
      if (!projectSkipped) {
        projectSkipped = true;
        result.skipped.push({ directory: join(cwd, ".tau"), reason: "The project is not trusted in Pi, so the packages it installs stay off." });
      }
      continue;
    }
    if (seen.has(entry.directory)) continue;
    const manifestPath = join(entry.directory, MANIFEST_FILE);
    if (!await stat(manifestPath).then((info) => info.isFile()).catch(() => false)) {
      result.errors.push({ path: manifestPath, message: `${entry.source.raw} is listed in packages.json but is not installed; run install again.` });
      continue;
    }
    try {
      const pkg = await readPackageFolder(entry.scope, entry.directory, options, publishers);
      seen.add(entry.directory);
      result.packages.push({ ...pkg, installedFrom: entry.source.raw });
    } catch (error) {
      result.errors.push({ path: manifestPath, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** What the settings inspector shows about the package folders: no code is loaded. */
export async function inspectExtensionPackages(cwd: string, agentDir: string, options: PackageScanOptions & { versions: ExtensionHostVersions; grantsFilePath?: string }): Promise<ExtensionInspection> {
  const [scan, grantsFile] = await Promise.all([
    listExtensionPackages(cwd, agentDir, options),
    readExtensionGrants(options.grantsFilePath),
  ]);
  return {
    versions: options.versions,
    directories: extensionPackageDirectories(cwd, options.home),
    packages: scan.packages.map((pkg) => ({
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      ...(pkg.manifest.version ? { version: pkg.manifest.version } : {}),
      ...(pkg.manifest.engines ? { engines: { ...pkg.manifest.engines } } : {}),
      permissions: pkg.manifest.permissions ?? [],
      isolation: packageIsolation(pkg.manifest),
      granted: isPackageGranted(pkg.manifest, grantsFile.grants),
      ...(pkg.manifest.source ? { source: { ...pkg.manifest.source } } : {}),
      ...(pkg.installedFrom ? { installedFrom: pkg.installedFrom } : {}),
      ...(pkg.signature ? { signature: { state: pkg.signature.state, label: describeSignature(pkg.signature) } } : {}),
      scope: pkg.scope,
      directory: pkg.directory,
      desktop: Boolean(pkg.desktopEntry),
      host: Boolean(pkg.hostEntry),
    })),
    errors: scan.errors,
    skipped: scan.skipped,
  };
}

/**
 * The host-side API modules, as files esbuild can read. `import.meta.url` is
 * `dist-electron/main/` in a built app and `src/main/` under Vitest, so both
 * spellings are tried; the unpacked path is what a native binary can open
 * inside a packaged Tau.
 */
const HOST_API_MODULES: Readonly<Record<string, string>> = {
  "tau/host-extension": "host-extension-api",
  "tau/host": "host-extension-worker-protocol",
};

function hostApiModulePath(specifier: string): string | undefined {
  const name = HOST_API_MODULES[specifier];
  if (!name) return undefined;
  const directory = unpackedPath(dirname(fileURLToPath(import.meta.url)));
  for (const extension of [".js", ".ts"]) {
    const candidate = join(directory, `${name}${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** What `bundleHostExtension` resolves `tau/host-extension` and `tau/host` to. */
export function hostApiAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const specifier of Object.keys(HOST_API_MODULES)) {
    const path = hostApiModulePath(specifier);
    if (path) aliases[specifier] = path;
  }
  return aliases;
}

/**
 * Compiles a host entry to one CommonJS module the main process can load.
 * Node builtins and Electron stay external; everything else is bundled, so a
 * package brings its own dependencies. `tau/host-extension` and `tau/host`
 * resolve to Tau's own API modules, which is why they never have to be shipped
 * inside a package.
 */
export async function bundleHostExtension(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: "inline",
    logLevel: "silent",
    external: ["electron", "node:*"],
    alias: hostApiAliases(),
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

/**
 * Compiles a package's Pi entry: the half that runs inside a Pi runtime Tau
 * does not own, loaded there by `.pi/extensions/tau-session-bridge.ts`. Pi
 * itself stays external — the entry runs inside it.
 */
export async function bundlePiExtension(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: "inline",
    logLevel: "silent",
    external: ["electron", "node:*", "@earendil-works/pi-coding-agent"],
    alias: hostApiAliases(),
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

const requireModule = createRequire(import.meta.url);

function isHostExtension(value: unknown): value is HostExtension {
  const candidate = value as Partial<HostExtension> | null;
  return Boolean(candidate && typeof candidate.activate === "function");
}

/**
 * Imports a compiled host entry. The module default-exports a HostExtension,
 * a factory returning one, or just `activate`; id and name fall back to the
 * manifest and must match it when given.
 */
/** Identity of the code a package's host half will run; the cache file is named after it. */
export function hostBundleHash(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

export async function writeHostExtensionBundle(code: string, manifest: ExtensionManifest, cacheDir = join(tmpdir(), "tau-host-extensions")): Promise<string> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const file = join(cacheDir, `${manifest.id}-${hostBundleHash(code)}.cjs`);
  // The content hash in the file name keys Node's module cache and lets an
  // unchanged package reuse its compiled file instead of rewriting it.
  if (!await stat(file).then((info) => info.isFile()).catch(() => false)) {
    await writeFile(file, code, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return file;
}

export async function importHostExtension(code: string, manifest: ExtensionManifest, cacheDir = join(tmpdir(), "tau-host-extensions")): Promise<HostExtension> {
  return requireHostExtension(await writeHostExtensionBundle(code, manifest, cacheDir), manifest);
}

/**
 * Loads an already-compiled host entry from disk. A package reaches this
 * through `importHostExtension`; a prebuilt kit hands over the file it shipped.
 */
export function requireHostExtension(file: string, manifest: ExtensionManifest): HostExtension {
  const module = requireModule(file) as { default?: unknown; activate?: unknown };
  let candidate: unknown = module.default ?? (typeof module.activate === "function" ? module : undefined);
  if (typeof candidate === "function") candidate = (candidate as () => unknown)();
  if (!isHostExtension(candidate)) throw new Error("the module must default-export a host extension ({ id?, name?, activate })");
  const id = (candidate as { id?: unknown }).id;
  if (id !== undefined && id !== manifest.id) throw new Error(`the module's id "${String(id)}" differs from the manifest id "${manifest.id}"`);
  const name = (candidate as { name?: unknown }).name;
  return {
    id: manifest.id,
    name: typeof name === "string" && name.trim() ? name : manifest.name,
    permissions: manifest.permissions ?? [],
    isolation: "in-process",
    activate: (context) => candidate.activate(context),
  };
}

/** One package's host half, with the identity of the code behind it. */
export interface LoadedHostPackage {
  extension: HostExtension;
  package: ExtensionPackage;
  /** Content hash of the compiled entry: the same code compiles to the same hash. */
  bundleHash: string;
  /** The cache file the hash names; a worker is started from it. */
  bundlePath: string;
}

export interface HostPackageLoadResult {
  extensions: LoadedHostPackage[];
  /** Packages the user has not approved; their code was never compiled or imported. */
  ungranted: ExtensionPackage[];
  errors: Array<{ path: string; message: string }>;
  skipped: Array<{ directory: string; reason: string }>;
}

/**
 * Finds, compiles and imports the host halves of the packages a workspace sees.
 * A package without a grant stops before the import, in both scopes: importing it
 * would already run its top-level code with everything the main process can reach.
 */
export async function loadHostExtensionPackages(
  cwd: string,
  agentDir: string,
  options: PackageScanOptions & {
    cacheDir?: string;
    grantsFilePath?: string;
    /** Overrides for the worker a package is isolated in (tests use smaller limits). */
    worker?: Omit<WorkerHostExtensionOptions, "id" | "name" | "permissions" | "file">;
  } = {},
): Promise<HostPackageLoadResult> {
  const [scan, grantsFile] = await Promise.all([
    listExtensionPackages(cwd, agentDir, options),
    readExtensionGrants(options.grantsFilePath),
  ]);
  const result: HostPackageLoadResult = { extensions: [], ungranted: [], errors: [...scan.errors], skipped: scan.skipped };
  for (const pkg of scan.packages) {
    if (!pkg.hostEntry) continue;
    if (!isPackageGranted(pkg.manifest, grantsFile.grants)) {
      result.ungranted.push(pkg);
      continue;
    }
    try {
      const code = await bundleHostExtension(pkg.hostEntry);
      const bundlePath = await writeHostExtensionBundle(code, pkg.manifest, options.cacheDir);
      // A package runs in a worker unless it declared, and was granted, the
      // privilege of running inside the host process.
      const extension = packageIsolation(pkg.manifest) === "in-process"
        ? await importHostExtension(code, pkg.manifest, options.cacheDir)
        : createWorkerHostExtension({
          id: pkg.manifest.id,
          name: pkg.manifest.name,
          permissions: pkg.manifest.permissions ?? [],
          file: bundlePath,
          ...(options.worker ?? {}),
        });
      result.extensions.push({ extension, package: pkg, bundleHash: hostBundleHash(code), bundlePath });
    } catch (error) {
      result.errors.push({ path: pkg.hostEntry, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
