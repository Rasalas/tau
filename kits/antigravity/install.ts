import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AntigravityInstallEvent } from "./protocol.js";
import { executableNames, releaseAssetFor, type ReleaseAsset, type ReleaseFile } from "./release.js";
import { extractZipEntry, isPlainFileEntry, readZipDirectory } from "./zip.js";

/**
 * Where the ACP server comes from and how it is kept. Google publishes it as
 * a zip of two executables; Tau downloads it once into its own state folder,
 * verifies size and SHA-256 against the release table, and points
 * `active.json` at the verified copy. A `TAU_ANTIGRAVITY_ACP_COMMAND` override
 * or a copy on the PATH is used as is, as long as the harness sits beside it.
 */
export interface AntigravityExecutable {
  executablePath: string;
  harnessPath: string;
  source: "override" | "managed" | "path";
  version?: string;
}

export interface InstallRecord {
  releaseId: string;
  version: string;
  executable: ReleaseFile;
  harness: ReleaseFile;
}

export class AntigravityNotInstalledError extends Error {
  readonly name = "AntigravityNotInstalledError";
}

const RELEASE_ID = /^[a-f0-9]{64}$/u;
const RECORD_FILE = ".install-complete.json";
const ACTIVE_FILE = "active.json";
const SPARE_BYTES = 256 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;

export function managedDirectory(stateDir: string, platform: string, arch: string): string {
  return join(stateDir, "tools", "antigravity-acp", `${platform}-${arch}`);
}

async function isExecutableFile(path: string, platform: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (platform === "win32") return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The server plus the harness beside it; a lone executable is not an installation. */
async function fromExecutable(executablePath: string, platform: string, source: AntigravityExecutable["source"], version?: string): Promise<AntigravityExecutable | undefined> {
  const names = executableNames(platform);
  const harnessPath = join(dirname(executablePath), names.harness);
  if (!await isExecutableFile(executablePath, platform) || !await isExecutableFile(harnessPath, platform)) return undefined;
  return { executablePath, harnessPath, source, ...(version ? { version } : {}) };
}

async function readRecord(directory: string): Promise<InstallRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(directory, RECORD_FILE), "utf8")) as Partial<InstallRecord>;
    if (typeof raw.releaseId !== "string" || !RELEASE_ID.test(raw.releaseId) || typeof raw.version !== "string") return undefined;
    const file = (value: unknown): ReleaseFile | undefined => {
      const candidate = value as Partial<ReleaseFile> | undefined;
      return candidate && typeof candidate.name === "string" && typeof candidate.bytes === "number" && Number.isSafeInteger(candidate.bytes) && candidate.bytes > 0
        ? { name: candidate.name, bytes: candidate.bytes }
        : undefined;
    };
    const executable = file(raw.executable);
    const harness = file(raw.harness);
    return executable && harness ? { releaseId: raw.releaseId, version: raw.version, executable, harness } : undefined;
  } catch {
    return undefined;
  }
}

/** A managed release is complete when its record and both files with the recorded sizes are there. */
async function completedRelease(managed: string, releaseId: string, platform: string): Promise<AntigravityExecutable | undefined> {
  if (!RELEASE_ID.test(releaseId)) return undefined;
  const directory = join(managed, "versions", releaseId);
  const record = await readRecord(directory);
  if (!record || record.releaseId !== releaseId) return undefined;
  for (const file of [record.executable, record.harness]) {
    try {
      const info = await stat(join(directory, file.name));
      if (!info.isFile() || info.size !== file.bytes) return undefined;
    } catch {
      return undefined;
    }
  }
  return fromExecutable(join(directory, record.executable.name), platform, "managed", record.version);
}

export interface ResolveOptions {
  /** `TAU_ANTIGRAVITY_ACP_COMMAND`: a path, or a command name looked up on the PATH. */
  override?: string;
  stateDir: string;
  platform: string;
  arch: string;
  findCommand(name: string): string | undefined;
}

export async function resolveAntigravity(options: ResolveOptions): Promise<AntigravityExecutable> {
  const { platform } = options;
  const override = options.override?.trim();
  if (override) {
    const path = isAbsolute(override) || override.includes("/") || override.includes("\\") ? resolve(override) : options.findCommand(override);
    const found = path ? await fromExecutable(path, platform, "override") : undefined;
    if (!found) throw new AntigravityNotInstalledError(`The Antigravity executable "${override}" or the ${executableNames(platform).harness} beside it is missing or not executable.`);
    return found;
  }
  const managed = managedDirectory(options.stateDir, platform, options.arch);
  try {
    const active = JSON.parse(await readFile(join(managed, ACTIVE_FILE), "utf8")) as { releaseId?: unknown };
    if (typeof active.releaseId === "string") {
      const found = await completedRelease(managed, active.releaseId, platform);
      if (found) return found;
      throw new AntigravityNotInstalledError("The managed Antigravity runtime is incomplete. Install it again.");
    }
  } catch (error) {
    if (error instanceof AntigravityNotInstalledError) throw error;
  }
  const onPath = options.findCommand(executableNames(platform).executable);
  const found = onPath ? await fromExecutable(onPath, platform, "path") : undefined;
  if (found) return found;
  const asset = releaseAssetFor(platform, options.arch);
  throw new AntigravityNotInstalledError(asset
    ? "Antigravity is not installed. Install it from Settings, or point TAU_ANTIGRAVITY_ACP_COMMAND at Google's agy_acp_server."
    : `Google does not publish an Antigravity runtime for ${platform}-${options.arch}.`);
}

export interface InstallOptions {
  stateDir: string;
  platform: string;
  arch: string;
  /** The release to install; the table's row for this platform otherwise (tests pass their own). */
  asset?: ReleaseAsset;
  fetch?: typeof fetch;
  onProgress?(event: AntigravityInstallEvent): void;
  signal?: AbortSignal;
  /** Runs the freshly extracted pair before it is activated; a throw discards it. */
  validate?(executable: AntigravityExecutable): Promise<void>;
  now?(): number;
}

async function freeBytes(directory: string): Promise<number | undefined> {
  try {
    const info = await statfs(directory);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

/** Downloads, verifies, extracts and activates the pinned release; an existing verified copy is reused. */
export async function installAntigravity(options: InstallOptions): Promise<AntigravityExecutable> {
  const { platform, arch } = options;
  const asset = options.asset ?? releaseAssetFor(platform, arch);
  if (!asset) throw new AntigravityNotInstalledError(`Google does not publish an Antigravity runtime for ${platform}-${arch}.`);
  const managed = managedDirectory(options.stateDir, platform, arch);
  const versions = join(managed, "versions");
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const existing = await completedRelease(managed, asset.sha256, platform);
  if (existing && existing.version === asset.version) {
    await activate(managed, asset.sha256);
    options.onProgress?.({ phase: "installed", message: `Antigravity ${asset.version} is installed.` });
    return existing;
  }
  const free = await freeBytes(versions);
  const needed = asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + SPARE_BYTES;
  if (free !== undefined && free < needed) throw new Error(`Antigravity needs at least ${Math.ceil(needed / (1024 * 1024))} MiB of free space to install.`);
  const staging = await mkdtemp(join(versions, ".install-"));
  try {
    const archive = join(staging, "download.zip");
    await download(asset, archive, options);
    options.onProgress?.({ phase: "extracting", downloadedBytes: asset.archiveBytes, totalBytes: asset.archiveBytes });
    const runtime = join(staging, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    await extract(asset, archive, runtime);
    await rm(archive, { force: true });
    if (platform !== "win32") {
      await chmod(join(runtime, asset.executable.name), 0o755);
      await chmod(join(runtime, asset.harness.name), 0o755);
    }
    options.onProgress?.({ phase: "verifying" });
    const candidate = await fromExecutable(join(runtime, asset.executable.name), platform, "managed", asset.version);
    if (!candidate) throw new Error("The extracted Antigravity files are not executable.");
    await options.validate?.(candidate);
    const record: InstallRecord = { releaseId: asset.sha256, version: asset.version, executable: asset.executable, harness: asset.harness };
    await writeFile(join(runtime, RECORD_FILE), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    const final = join(versions, asset.sha256);
    try {
      await rename(runtime, final);
    } catch {
      // Another install of the same release finished first; keep theirs if it is complete.
      if (!await completedRelease(managed, asset.sha256, platform)) throw new Error("The Antigravity release could not be placed; the previous release is unchanged.");
    }
    await activate(managed, asset.sha256);
    const installed = await completedRelease(managed, asset.sha256, platform);
    if (!installed) throw new Error("The Antigravity release was placed but does not read back as complete.");
    options.onProgress?.({ phase: "installed", message: `Antigravity ${asset.version} is installed.` });
    return installed;
  } catch (error) {
    options.onProgress?.({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Streams the archive to disk while hashing; size and hash must match the release row exactly. */
async function download(asset: ReleaseAsset, destination: string, options: InstallOptions): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const response = await fetchImpl(asset.url, { signal: options.signal ?? null, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Downloading Antigravity failed: HTTP ${response.status}.`);
  const hash = createHash("sha256");
  const handle = await open(destination, "wx", 0o600);
  let downloaded = 0;
  let lastReport = now();
  options.onProgress?.({ phase: "downloading", downloadedBytes: 0, totalBytes: asset.archiveBytes });
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      downloaded += value.byteLength;
      if (downloaded > asset.archiveBytes) throw new Error("The Antigravity download is larger than the pinned release. Nothing was installed.");
      hash.update(value);
      await handle.write(value);
      if (now() - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now();
        options.onProgress?.({ phase: "downloading", downloadedBytes: downloaded, totalBytes: asset.archiveBytes });
      }
    }
  } finally {
    await handle.close();
  }
  if (downloaded !== asset.archiveBytes || hash.digest("hex") !== asset.sha256) {
    throw new Error("The Antigravity download failed its size or SHA-256 check. Nothing was installed.");
  }
}

/** Exactly the two files the release names, flat, plain, with the recorded sizes. */
async function extract(asset: ReleaseAsset, archive: string, runtime: string): Promise<void> {
  const entries = await readZipDirectory(archive);
  if (entries.length !== 2) throw new Error(`The Antigravity archive holds ${entries.length} members, not the two the release names.`);
  const expected = new Map<string, ReleaseFile>([[asset.executable.name, asset.executable], [asset.harness.name, asset.harness]]);
  const seen = new Set<string>();
  for (const entry of entries) {
    const file = expected.get(entry.name);
    if (!file || seen.has(entry.name) || !isPlainFileEntry(entry) || entry.uncompressedSize !== file.bytes) {
      throw new Error(`The Antigravity archive member "${basename(entry.name)}" is unexpected, unsafe, or incorrectly sized.`);
    }
    seen.add(entry.name);
    await extractZipEntry(archive, entry, join(runtime, entry.name), file.bytes);
  }
  if (seen.size !== 2) throw new Error("The Antigravity archive is missing one of its two files.");
}

/** The pointer commits the install: written beside `versions/` and renamed into place. */
async function activate(managed: string, releaseId: string): Promise<void> {
  const temporary = join(managed, `.active-${process.pid}-${Date.now()}.json`);
  await writeFile(temporary, `${JSON.stringify({ releaseId })}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, join(managed, ACTIVE_FILE));
}
