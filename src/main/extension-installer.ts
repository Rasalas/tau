import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MANIFEST_FILE, parseExtensionManifest } from "./extension-packages.js";
import { HostCommandError } from "./host-extensions.js";
import {
  addPackageSource,
  gitStoreDirectory,
  listInstalledSources,
  npmStoreDirectory,
  packagesFilePath,
  parseExtensionSource,
  readPackagesFile,
  removePackageSource,
  sourceDirectory,
  type ExtensionSource,
  type PackageScope,
} from "./extension-sources.js";
import { describeSignature, readTrustedPublishers, verifyExtensionSignature, type SignatureState } from "./extension-signature.js";
import { findExecutable, gitExecutable } from "./shell-environment.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 8 * 1024 * 1024;

export interface InstallerOptions {
  cwd: string;
  home?: string;
  /** One line per step, for the host job that runs the command. */
  progress?: (message: string) => void;
  /** Where `npm` comes from; the host seam's `findCommand` by default. */
  findCommand?: (name: string) => string | undefined;
  publishersFilePath?: string;
  signal?: AbortSignal;
}

/** One line of `list`, and what `install` and `update` answer with. */
export interface InstalledExtension {
  source: string;
  scope: PackageScope;
  directory: string;
  id?: string;
  name?: string;
  version?: string;
  signature: SignatureState;
  /** Why the package could not be read, if it could not. */
  error?: string;
}

function run(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
}

function locate(options: InstallerOptions, name: string): string | undefined {
  return (options.findCommand ?? ((command: string) => findExecutable(command)))(name);
}

function npmExecutable(options: InstallerOptions): string {
  const npm = locate(options, "npm");
  if (!npm) throw new HostCommandError("npm is not on this machine's PATH; install Node's npm or use a git: source.");
  return npm;
}

/** The npm store is a plain project folder, so `npm install --prefix` never walks up to another one. */
async function ensureNpmStore(home: string): Promise<string> {
  const directory = npmStoreDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = join(directory, "package.json");
  if (!await stat(manifest).then((info) => info.isFile()).catch(() => false)) {
    await writeFile(manifest, `${JSON.stringify({ name: "tau-extensions", private: true, version: "0.0.0" }, null, 2)}\n`, "utf8");
  }
  return directory;
}

async function fetchSource(source: ExtensionSource, home: string, options: InstallerOptions): Promise<string> {
  const directory = sourceDirectory(source, home);
  if (source.kind === "npm") {
    const store = await ensureNpmStore(home);
    options.progress?.(`npm install ${source.spec ? `${source.value}@${source.spec}` : source.value}`);
    await run(npmExecutable(options), [
      "install", "--prefix", store, "--no-audit", "--no-fund", "--save",
      source.spec ? `${source.value}@${source.spec}` : source.value,
    ], { signal: options.signal });
    return directory;
  }
  if (source.kind === "git") {
    const exists = await stat(join(directory, ".git")).then((info) => info.isDirectory()).catch(() => false);
    if (exists) {
      options.progress?.(`git pull ${source.value}`);
      await run(locate(options, "git") ?? gitExecutable(), ["pull", "--ff-only"], { cwd: directory, signal: options.signal });
      return directory;
    }
    await mkdir(gitStoreDirectory(home), { recursive: true, mode: 0o700 });
    await rm(directory, { recursive: true, force: true });
    options.progress?.(`git clone --depth 1 ${source.value}`);
    await run(locate(options, "git") ?? gitExecutable(), ["clone", "--depth", "1", "--", source.value, directory], { signal: options.signal });
    return directory;
  }
  if (!await stat(directory).then((info) => info.isDirectory()).catch(() => false)) {
    throw new HostCommandError(`${directory} is not a folder.`);
  }
  return directory;
}

async function describe(source: string, scope: PackageScope, directory: string, options: InstallerOptions): Promise<InstalledExtension> {
  const manifestPath = join(directory, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return { source, scope, directory, signature: { state: "unsigned" }, error: `${manifestPath} does not exist; this folder is not a Tau extension package.` };
  }
  try {
    const { manifest } = parseExtensionManifest(directory, raw);
    const publishers = await readTrustedPublishers(options.publishersFilePath ?? undefined);
    const signature = await verifyExtensionSignature(directory, manifest, publishers);
    return {
      source,
      scope,
      directory,
      id: manifest.id,
      name: manifest.name,
      ...(manifest.version ? { version: manifest.version } : {}),
      signature,
      ...(signature.state === "tampered" ? { error: describeSignature(signature) } : {}),
    };
  } catch (error) {
    return { source, scope, directory, signature: { state: "unsigned" }, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Fetches a source, checks that it is a package and records it in the scope's
 * `packages.json`. Nothing is activated: an unapproved package still waits for
 * its permission grant before either half runs.
 */
export async function installExtensionSource(raw: string, scope: PackageScope, options: InstallerOptions): Promise<InstalledExtension> {
  const home = options.home ?? homedir();
  const source = parseExtensionSource(raw, options.cwd);
  const directory = await fetchSource(source, home, options);
  const installed = await describe(source.raw, scope, directory, options);
  if (installed.error) {
    // Nothing was recorded, so leave nothing behind in the npm store either.
    if (source.kind === "npm") {
      await run(npmExecutable(options), ["uninstall", "--prefix", npmStoreDirectory(home), "--no-audit", "--no-fund", source.value], { signal: options.signal })
        .catch(() => undefined);
    }
    throw new HostCommandError(`${source.raw}: ${installed.error}`);
  }
  options.progress?.(`recording ${source.raw} in ${scope} packages.json`);
  await addPackageSource(packagesFilePath(scope, options.cwd, home), source.raw);
  return installed;
}

export interface RemovalResult {
  source: string;
  scope: PackageScope;
  removed: boolean;
  /** True when the folder the source resolved to was deleted as well. */
  deleted: boolean;
}

/** Drops a source from `packages.json` and deletes what Tau fetched for it. */
export async function removeExtensionSource(raw: string, scope: PackageScope, options: InstallerOptions): Promise<RemovalResult> {
  const home = options.home ?? homedir();
  const source = parseExtensionSource(raw, options.cwd);
  const removed = await removePackageSource(packagesFilePath(scope, options.cwd, home), source.raw);
  let deleted = false;
  // A local path is the user's own checkout; Tau only forgets it.
  if (source.kind !== "path" && !(await stillListed(source.raw, scope, options.cwd, home))) {
    const directory = sourceDirectory(source, home);
    if (source.kind === "npm") {
      options.progress?.(`npm uninstall ${source.value}`);
      await run(npmExecutable(options), ["uninstall", "--prefix", npmStoreDirectory(home), "--no-audit", "--no-fund", source.value], { signal: options.signal })
        .catch(() => undefined);
      deleted = !await stat(directory).then(() => true).catch(() => false);
    } else {
      await rm(directory, { recursive: true, force: true });
      deleted = true;
    }
  }
  return { source: source.raw, scope, removed, deleted };
}

/** The other scope may still want the same source; then nothing is deleted. */
async function stillListed(raw: string, removedFrom: PackageScope, cwd: string, home: string): Promise<boolean> {
  const other: PackageScope = removedFrom === "global" ? "project" : "global";
  const file = await readPackagesFile(packagesFilePath(other, cwd, home));
  return file.sources.includes(raw);
}

/** Re-fetches one source, or every source both packages files list. */
export async function updateExtensionSources(raw: string | undefined, options: InstallerOptions): Promise<InstalledExtension[]> {
  const home = options.home ?? homedir();
  const installed = await listInstalledSources(options.cwd, home);
  const wanted = raw ? parseExtensionSource(raw, options.cwd).raw : undefined;
  const targets = installed.filter((entry) => !entry.error && (wanted === undefined || entry.source.raw === wanted));
  if (wanted !== undefined && targets.length === 0) throw new HostCommandError(`${wanted} is not installed.`);
  const results: InstalledExtension[] = [];
  for (const entry of targets) {
    try {
      const directory = await fetchSource(entry.source, home, options);
      results.push(await describe(entry.source.raw, entry.scope, directory, options));
    } catch (error) {
      results.push({
        source: entry.source.raw,
        scope: entry.scope,
        directory: entry.directory,
        signature: { state: "unsigned" },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** What `list` answers: every source, with the package it resolved to. */
export async function listExtensionSources(options: InstallerOptions): Promise<InstalledExtension[]> {
  const home = options.home ?? homedir();
  const installed = await listInstalledSources(options.cwd, home);
  return Promise.all(installed.map(async (entry) => entry.error
    ? { source: entry.source.raw, scope: entry.scope, directory: entry.directory, signature: { state: "unsigned" } as SignatureState, error: entry.error }
    : describe(entry.source.raw, entry.scope, entry.directory, options)));
}
