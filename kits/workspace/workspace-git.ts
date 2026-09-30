import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { findExecutable, gitExecutable } from "tau/host-extension";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type {
  ChangeStatus,
  CommitResult,
  DiffLoadOptions,
  UiChangedFile,
  UiDiffHunk,
  UiDiffLine,
  UiTerminal,
  UiFileDiff,
  PullResult,
  PushResult,
  UiRef,
  UiWorktree,
  UiWorktreeStatus,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceChangesQuery,
  WorkspaceInfo,
} from "tau/host-extension";
import {
  type StoredTurnCheckpoint,
  type TurnRestoreBackup,
  isTurnSnapshotId,
  namespacedSnapshotRef,
  sanitizeTurnSnapshotComponent,
  turnSnapshotRef,
} from "./turn-checkpoint-codec.js";
import type { TurnRestoreTransaction } from "./turn-checkpoint-types.js";
import { normalizeDiffLoadOptions } from "./turn-checkpoint-diff.js";
import {
  branchBaseConfigKey,
  readBranchBase,
  readWorktreeConfig,
  resolveWorktreeParent,
} from "./agent-worktrees.js";
import { listLiveWorkspaceLeaseSessions } from "./workspace-checkpoint-lease.js";

const execFileAsync = promisify(execFile);

const EMPTY_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_CONTEXT_LINES = 100_000;

function diffViewArguments(options: DiffLoadOptions): string[] {
  const requested = options.contextLines;
  const contextLines = Number.isFinite(requested)
    ? Math.min(MAX_DIFF_CONTEXT_LINES, Math.max(0, Math.floor(requested ?? DEFAULT_DIFF_CONTEXT_LINES)))
    : DEFAULT_DIFF_CONTEXT_LINES;
  return [`-U${contextLines}`, ...(options.ignoreWhitespace ? ["--ignore-all-space"] : [])];
}

/**
 * Plain folders do not have Git objects to anchor a turn. Keep their bounded,
 * content-addressed snapshots outside user data while retaining the same
 * namespaced IDs and lazy diff API as the Git backend.
 */
const FILESYSTEM_SNAPSHOT_ROOT = join(tmpdir(), "tau-workspace-snapshots");
const FILESYSTEM_MAX_FILES = 20_000;
const FILESYSTEM_MAX_BYTES = 128 * 1024 * 1024;
const FILESYSTEM_MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILESYSTEM_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-electron", ".next"]);

interface FilesystemSnapshotFile {
  hash: string;
  size: number;
  /** Permission bits captured with the file; special type bits are excluded. */
  mode?: number;
  /** Captured once so summary generation never rereads historical blobs. */
  lines?: number;
  /** Large files retain identity metadata but intentionally no historical bytes. */
  contentAvailable: boolean;
  unavailableReason?: string;
}

interface FilesystemSnapshotDirectory {
  /** Permission bits captured with the directory; special type bits excluded. */
  mode: number;
}

interface FilesystemSnapshotManifest {
  version: 1;
  id: string;
  cwd: string;
  treeId: string;
  files: Record<string, FilesystemSnapshotFile>;
  /** Empty directories and directory permissions are part of the snapshot. */
  directories: Record<string, FilesystemSnapshotDirectory>;
  /** A false value is explicit: the scan did not cover the complete folder. */
  complete: boolean;
  omittedFileCount: number;
  omittedBytes: number;
  omissionReasons: string[];
}

function filesystemWorkspaceKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 32);
}

function filesystemManifestPath(cwd: string, id: string): string {
  const components = id.split("/").slice(3);
  return join(FILESYSTEM_SNAPSHOT_ROOT, filesystemWorkspaceKey(cwd), "checkpoints", ...components) + ".json";
}

function filesystemBlobPath(cwd: string, hash: string): string {
  // Blobs are namespaced with the canonical workspace. A GC sweep protected
  // by workspace A's lease can therefore never delete a blob that workspace
  // B is publishing before its manifest becomes visible.
  return join(FILESYSTEM_SNAPSHOT_ROOT, filesystemWorkspaceKey(cwd), "blobs", hash);
}

async function readFilesystemSnapshot(cwd: string, id: string): Promise<FilesystemSnapshotManifest | undefined> {
  if (!isTurnSnapshotId(id)) return undefined;
  try {
    const value = JSON.parse(await readFile(filesystemManifestPath(await realpath(cwd).catch(() => resolve(cwd)), id), "utf8")) as Partial<FilesystemSnapshotManifest>;
    if (value.version !== 1 || value.id !== id || typeof value.cwd !== "string" || typeof value.treeId !== "string"
      || !value.files || typeof value.files !== "object") return undefined;
    const files: Record<string, FilesystemSnapshotFile> = {};
    const directories: Record<string, FilesystemSnapshotDirectory> = {};
    let missingModeMetadata = false;
    for (const [path, candidate] of Object.entries(value.files)) {
      if (!candidate || typeof candidate !== "object") return undefined;
      const file = candidate as Partial<FilesystemSnapshotFile>;
      if (typeof file.hash !== "string" || !/^[0-9a-f]{64}$/iu.test(file.hash)
        || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) return undefined;
      if (file.lines !== undefined && (!Number.isSafeInteger(file.lines) || file.lines < 0)) return undefined;
      if (file.mode !== undefined && (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o7777)) return undefined;
      if (file.mode === undefined) missingModeMetadata = true;
      const unavailableReason = typeof file.unavailableReason === "string"
        ? file.unavailableReason.slice(0, 240)
        : undefined;
      files[path] = {
        hash: file.hash,
        size: file.size,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
        ...(file.lines === undefined ? {} : { lines: file.lines }),
        contentAvailable: file.contentAvailable !== false,
        ...(unavailableReason ? { unavailableReason } : {}),
      };
    }
    if (value.directories !== undefined) {
      if (!value.directories || typeof value.directories !== "object") return undefined;
      for (const [path, candidate] of Object.entries(value.directories)) {
        if (!candidate || typeof candidate !== "object") return undefined;
        const directory = candidate as Partial<FilesystemSnapshotDirectory>;
        if (directory.mode === undefined) {
          missingModeMetadata = true;
          continue;
        }
        if (!Number.isSafeInteger(directory.mode) || directory.mode < 0 || directory.mode > 0o7777) return undefined;
        directories[path] = { mode: directory.mode };
      }
    } else {
      // Older manifests did not retain empty directories or directory modes.
      // They remain readable for historical diffs but are not restorable.
      missingModeMetadata = true;
    }
    const omissionReasons = Array.isArray(value.omissionReasons)
      ? value.omissionReasons.filter((reason): reason is string => typeof reason === "string").map((reason) => reason.slice(0, 240)).slice(0, 8)
      : [];
    const omittedFileCount = Number.isSafeInteger(value.omittedFileCount) && (value.omittedFileCount as number) >= 0
      ? value.omittedFileCount as number
      : 0;
    const omittedBytes = Number.isSafeInteger(value.omittedBytes) && (value.omittedBytes as number) >= 0
      ? value.omittedBytes as number
      : 0;
    // Manifests written before coverage metadata existed are conservatively
    // partial. Replaying one cannot silently turn previously skipped files
    // into an apparently complete workspace state.
    const hasCoverageMetadata = typeof value.complete === "boolean";
    const complete = value.complete === true && !missingModeMetadata;
    if (missingModeMetadata && !omissionReasons.includes("file mode metadata is unavailable")) {
      omissionReasons.push("file mode metadata is unavailable");
    }
    return {
      version: 1,
      id,
      cwd: value.cwd,
      treeId: value.treeId,
      files,
      directories,
      complete,
      omittedFileCount: hasCoverageMetadata ? omittedFileCount : Math.max(1, omittedFileCount),
      omittedBytes,
      omissionReasons,
    };
  } catch {
    return undefined;
  }
}

async function writeFilesystemBlob(cwd: string, bytes: Buffer, hash: string): Promise<void> {
  const path = filesystemBlobPath(cwd, hash);
  if (await stat(path).then(() => true).catch(() => false)) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await rm(temporary, { force: true });
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

interface FilesystemCollection {
  files: Record<string, FilesystemSnapshotFile>;
  directories: Record<string, FilesystemSnapshotDirectory>;
  complete: boolean;
  omittedFileCount: number;
  omittedBytes: number;
  omissionReasons: string[];
}

interface FilesystemFileMetadata {
  hash: string;
  lines?: number;
}

async function streamFilesystemFileMetadata(path: string): Promise<FilesystemFileMetadata | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let lines = 0;
  let hasBytes = false;
  let binary = false;
  let lastByte = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hasBytes = true;
      hash.update(buffer.subarray(0, bytesRead));
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        if (byte === 0) binary = true;
        if (byte === 10) lines += 1;
        lastByte = byte;
      }
    }
  } finally {
    await handle.close();
  }
  if (binary) return { hash: hash.digest("hex") };
  return { hash: hash.digest("hex"), lines: hasBytes && lastByte !== 10 ? lines + 1 : lines };
}

async function collectFilesystemFiles(cwd: string): Promise<FilesystemCollection> {
  const files: Record<string, FilesystemSnapshotFile> = {};
  const directories: Record<string, FilesystemSnapshotDirectory> = {};
  let fileCount = 0;
  let totalBytes = 0;
  let complete = true;
  let omittedFileCount = 0;
  let omittedBytes = 0;
  const omissionReasons: string[] = [];
  const recordIncomplete = (reason: string): void => {
    complete = false;
    if (!omissionReasons.includes(reason) && omissionReasons.length < 8) omissionReasons.push(reason);
  };
  const recordOmission = (reason: string, bytes = 0, count = 1): void => {
    recordIncomplete(reason);
    omittedFileCount += count;
    omittedBytes += Math.max(0, bytes);
    if (!omissionReasons.includes(reason) && omissionReasons.length < 8) omissionReasons.push(reason);
  };
  const walk = async (directory: string, relative: string): Promise<void> => {
    if (fileCount >= FILESYSTEM_MAX_FILES) {
      recordOmission("file-count limit (20,000 files)");
      return;
    }
    if (totalBytes >= FILESYSTEM_MAX_BYTES) {
      recordOmission("workspace byte limit (128 MiB)");
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
      recordOmission("directory could not be read");
      return [];
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (fileCount >= FILESYSTEM_MAX_FILES) {
        recordOmission("file-count limit (20,000 files)");
        break;
      }
      if (totalBytes >= FILESYSTEM_MAX_BYTES) {
        recordOmission("workspace byte limit (128 MiB)");
        break;
      }
      if (entry.name === "." || entry.name === ".." || (relative === "" && FILESYSTEM_IGNORED_DIRECTORIES.has(entry.name))) continue;
      const path = join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const info = await lstat(path).catch(() => undefined);
        if (!info) {
          recordOmission("directory metadata could not be read");
        } else {
          directories[child.replaceAll("\\", "/")] = { mode: info.mode & 0o7777 };
        }
        await walk(path, child);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const info = await lstat(path).catch(() => undefined);
        recordOmission("symbolic links are not captured safely", info?.size ?? 0);
        continue;
      }
      if (!entry.isFile()) {
        const info = await lstat(path).catch(() => undefined);
        recordOmission("special filesystem entries are not captured safely", info?.size ?? 0);
        continue;
      }
      const info = await lstat(path).catch(() => undefined);
      if (!info) {
        recordOmission("file metadata could not be read");
        continue;
      }
      if (totalBytes + info.size > FILESYSTEM_MAX_BYTES) {
        // Large files are still hashed below so their identity is visible, but
        // crossing the workspace budget means the folder cannot be reported
        // as fully covered.
        recordIncomplete("workspace byte limit (128 MiB)");
      }
      if (info.size > FILESYSTEM_MAX_FILE_BYTES) {
        // Read the large file in bounded chunks. Its content is not retained,
        // but the full hash and line metadata still make a turn edit visible.
        recordIncomplete("content limit (8 MiB); large file content is unavailable");
        const metadata = await streamFilesystemFileMetadata(path);
        if (!metadata) {
          recordOmission("large file could not be read", info.size);
          continue;
        }
        files[child.replaceAll("\\", "/")] = {
          hash: metadata.hash,
          size: info.size,
          mode: info.mode & 0o7777,
          ...(metadata.lines === undefined ? {} : { lines: metadata.lines }),
          contentAvailable: false,
          unavailableReason: "Historical content was not stored because this file exceeds the 8 MiB content limit.",
        };
        fileCount += 1;
        totalBytes += info.size;
        continue;
      }
      if (totalBytes + info.size > FILESYSTEM_MAX_BYTES) {
        recordOmission("workspace byte limit (128 MiB)", info.size);
        continue;
      }
      const bytes = await readFile(path).catch(() => undefined);
      if (!bytes) {
        recordOmission("file content could not be read", info.size);
        continue;
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      let lines: number | undefined;
      if (bytes.length > 0 && !bytes.includes(0)) {
        lines = 0;
        for (const byte of bytes) if (byte === 10) lines += 1;
        if (bytes.at(-1) !== 10) lines += 1;
      }
      await writeFilesystemBlob(cwd, bytes, hash);
      files[child.replaceAll("\\", "/")] = {
        hash,
        size: bytes.length,
        mode: info.mode & 0o7777,
        ...(lines === undefined ? {} : { lines }),
        contentAvailable: true,
      };
      fileCount += 1;
      totalBytes += bytes.length;
    }
  };
  await walk(await realpath(cwd).catch(() => resolve(cwd)), "");
  return { files, directories, complete, omittedFileCount, omittedBytes, omissionReasons };
}

async function createFilesystemSnapshot(cwd: string, options: WorkspaceSnapshotOptions, ref: string): Promise<WorkspaceSnapshot> {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const collection = await collectFilesystemFiles(canonicalCwd);
  const treeId = createHash("sha256").update(JSON.stringify(collection)).digest("hex");
  const manifest: FilesystemSnapshotManifest = {
    version: 1,
    id: ref,
    cwd: canonicalCwd,
    treeId,
    ...collection,
  };
  const path = filesystemManifestPath(canonicalCwd, ref);
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing) {
    let previous: Partial<FilesystemSnapshotManifest> | undefined;
    try { previous = JSON.parse(existing) as Partial<FilesystemSnapshotManifest>; } catch { /* overwritten below only if invalid */ }
    const legacyTreeId = createHash("sha256").update(JSON.stringify(collection.files)).digest("hex");
    if (previous?.treeId !== treeId && previous?.treeId !== legacyTreeId) {
      throw new Error(`Snapshot ref ${ref} already points to another tree.`);
    }
    const previousHasModes = previous?.files && typeof previous.files === "object"
      ? Object.values(previous.files).every((file) => Boolean(file && typeof file === "object"
        && typeof (file as Partial<FilesystemSnapshotFile>).mode === "number"))
      : false;
    const previousHasDirectoryModes = previous?.directories && typeof previous.directories === "object"
      ? Object.values(previous.directories).every((directory) => Boolean(directory && typeof directory === "object"
        && typeof (directory as Partial<FilesystemSnapshotDirectory>).mode === "number"))
      : false;
    return {
      id: ref,
      ref,
      treeId,
      cwd: canonicalCwd,
      backend: "filesystem",
      complete: collection.complete && previous?.complete === true && previousHasModes && previousHasDirectoryModes,
      sessionId: options.namespace.split("/")[0],
      turnId: options.namespace.split("/")[1],
      phase: options.phase,
    };
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readFilesystemSnapshot(canonicalCwd, ref);
      if (!raced || raced.treeId !== treeId) throw new Error(`Snapshot ref ${ref} already points to another tree.`);
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return {
    id: ref,
    ref,
    treeId,
    cwd: canonicalCwd,
    backend: "filesystem",
    complete: collection.complete,
    sessionId: options.namespace.split("/")[0],
    turnId: options.namespace.split("/")[1],
    phase: options.phase,
  };
}

async function filesystemSnapshotPair(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
): Promise<{ before: FilesystemSnapshotManifest; after: FilesystemSnapshotManifest } | undefined> {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const [before, after] = await Promise.all([
    readFilesystemSnapshot(canonicalCwd, beforeSnapshotId),
    readFilesystemSnapshot(canonicalCwd, afterSnapshotId),
  ]);
  if (!before || !after || before.cwd !== canonicalCwd || after.cwd !== canonicalCwd) return undefined;
  return { before, after };
}

/** A restore must never use a partial plain-folder manifest as a boundary. */
async function assertFilesystemRestoreable(
  cwd: string,
  pair: { before: FilesystemSnapshotManifest; after: FilesystemSnapshotManifest },
  label: string,
): Promise<void> {
  if (!pair.before.complete || !pair.after.complete) {
    throw new Error(`${label} workspace snapshot is incomplete and cannot be restored safely.`);
  }
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  for (const [phase, manifest] of [["before", pair.before], ["after", pair.after]] as const) {
    const directoryPaths = new Set(Object.keys(manifest.directories));
    const assertSnapshotPath = (path: string, kind: "file" | "directory"): void => {
      const components = path.split("/");
      if (!path || path.startsWith("/") || path.includes("\\")
        || components.some((component) => component.length === 0 || component === "." || component === "..")) {
        throw new Error(`${label} ${phase} snapshot has an invalid ${kind} path ${path}.`);
      }
      if (kind === "file" && directoryPaths.has(path)) {
        throw new Error(`${label} ${phase} snapshot has both a file and directory at ${path}.`);
      }
      for (let index = 1; index < components.length; index += 1) {
        const parent = components.slice(0, index).join("/");
        if (!directoryPaths.has(parent)) {
          throw new Error(`${label} ${phase} snapshot is missing directory metadata for ${parent}.`);
        }
      }
    };
    for (const [path, file] of Object.entries(manifest.files)) {
      assertSnapshotPath(path, "file");
      await assertWorkspacePath(canonicalCwd, path);
      if (file.mode === undefined) {
        throw new Error(`${label} ${phase} snapshot has no file mode metadata for ${path}.`);
      }
      if (!file.contentAvailable) {
        throw new Error(`${label} ${phase} snapshot has no content for ${path}.`);
      }
      const blob = await readFile(filesystemBlobPath(canonicalCwd, file.hash)).catch(() => undefined);
      if (!blob) {
        throw new Error(`${label} ${phase} snapshot content for ${path} is unavailable.`);
      }
      if (blob.length !== file.size || createHash("sha256").update(blob).digest("hex") !== file.hash) {
        throw new Error(`${label} ${phase} snapshot content for ${path} failed integrity verification.`);
      }
    }
    for (const [path, directory] of Object.entries(manifest.directories)) {
      assertSnapshotPath(path, "directory");
      await assertWorkspacePath(canonicalCwd, path);
      if (!Number.isSafeInteger(directory.mode) || directory.mode < 0 || directory.mode > 0o7777) {
        throw new Error(`${label} ${phase} snapshot has invalid directory mode metadata for ${path}.`);
      }
    }
  }
  for (const path of Object.keys(pair.before.files)) await assertWorkspacePath(canonicalCwd, path);
}

async function filesystemPaths(cwd: string): Promise<{ files: Set<string>; directories: Set<string> }> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || (relative === "" && FILESYSTEM_IGNORED_DIRECTORIES.has(entry.name))) continue;
      const path = join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories.add(child);
        await walk(path, child);
      } else {
        files.add(child);
      }
    }
  };
  await walk(canonicalCwd, "");
  return { files, directories };
}

async function applyFilesystemSnapshot(
  cwd: string,
  manifest: FilesystemSnapshotManifest,
): Promise<void> {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const current = await filesystemPaths(canonicalCwd);
  const targetFiles = new Set(Object.keys(manifest.files));
  const targetDirectories = new Set<string>(Object.keys(manifest.directories));
  for (const path of targetFiles) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      targetDirectories.add(components.slice(0, index).join("/"));
    }
  }

  // A previous snapshot may have made a directory read-only. Temporarily
  // grant the owner access while materializing/removing paths; exact target
  // modes are applied after the tree is complete.
  for (const path of [...current.directories].sort((left, right) => left.length - right.length)) {
    await assertWorkspacePath(canonicalCwd, path);
    const destination = join(canonicalCwd, path);
    const info = await lstat(destination).catch(() => undefined);
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      await chmod(destination, (info.mode & 0o7777) | 0o700);
    }
  }

  // Stage each file in its destination directory. The backup pair is already
  // verified, so a failure can be rolled back without relying on the live tree.
  for (const [path, file] of Object.entries(manifest.files)) {
    await assertWorkspacePath(canonicalCwd, path);
    const destination = join(canonicalCwd, path);
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const parent = join(canonicalCwd, ...components.slice(0, index));
      const parentInfo = await lstat(parent).catch(() => undefined);
      if (parentInfo && (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())) {
        await rm(parent, { recursive: true, force: true });
      }
    }
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tau-restore`;
    try {
      const bytes = await readFile(filesystemBlobPath(canonicalCwd, file.hash));
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
      if (file.mode === undefined) throw new Error(`Workspace snapshot has no file mode for ${path}.`);
      await chmod(destination, file.mode);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  // Remove files that are absent from the target. Ignored top-level folders
  // were excluded by snapshot capture and therefore remain untouched.
  await Promise.all([...current.files]
    .filter((path) => !targetFiles.has(path))
    .map(async (path) => {
      await assertWorkspacePath(canonicalCwd, path);
      await rm(join(canonicalCwd, path), { recursive: true, force: true });
    }));
  const directories = [...current.directories].sort((left, right) => right.length - left.length);
  for (const path of directories) {
    if (targetDirectories.has(path)) continue;
    await assertWorkspacePath(canonicalCwd, path);
    await rm(join(canonicalCwd, path), { recursive: true, force: true }).catch(() => undefined);
  }

  // Apply directory modes only after all paths have been materialized and
  // removed. A target directory may be empty, so it cannot be inferred only
  // from file parents.
  for (const [path, directory] of Object.entries(manifest.directories)
    .sort(([left], [right]) => right.length - left.length)) {
    await assertWorkspacePath(canonicalCwd, path);
    const destination = join(canonicalCwd, path);
    const info = await lstat(destination).catch(() => undefined);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      await rm(destination, { recursive: true, force: true });
    }
    await mkdir(destination, { recursive: true });
    await chmod(destination, directory.mode);
  }
}

/** Publishes one plain-folder manifest under a new session namespace. */
async function cloneFilesystemSnapshot(
  cwd: string,
  sourceId: string,
  targetId: string,
  expectedTreeId: string,
): Promise<boolean> {
  const source = await readFilesystemSnapshot(cwd, sourceId);
  if (!source || source.treeId !== expectedTreeId) {
    throw new Error(`Filesystem snapshot ${sourceId} is unavailable or changed.`);
  }
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const targetPath = filesystemManifestPath(canonicalCwd, targetId);
  const existing = await readFilesystemSnapshot(canonicalCwd, targetId);
  if (existing) {
    if (existing.treeId !== expectedTreeId || existing.cwd !== canonicalCwd) {
      throw new Error(`Fork snapshot ref ${targetId} already points to another tree.`);
    }
    return false;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...source, id: targetId, cwd: canonicalCwd })}\n`, { flag: "wx", mode: 0o600 });
    // A hard-link publication is create-if-absent, unlike rename which could
    // overwrite a concurrent target generation and violate immutability.
    await link(temporary, targetPath).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readFilesystemSnapshot(canonicalCwd, targetId);
      if (!raced || raced.treeId !== expectedTreeId || raced.cwd !== canonicalCwd) {
        throw new Error(`Fork snapshot ref ${targetId} already points to another tree.`);
      }
    });
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function filesystemLineCount(cwd: string, file: FilesystemSnapshotFile | undefined): Promise<number> {
  if (!file) return 0;
  if (file.lines !== undefined) return file.lines;
  if (!file.contentAvailable) return 0;
  const bytes = await readFile(filesystemBlobPath(cwd, file.hash)).catch(() => undefined);
  if (!bytes || bytes.includes(0)) return 0;
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines += 1;
  return lines + (bytes.at(-1) === 10 ? 0 : 1);
}

async function diffFilesystemSnapshots(
  pair: { before: FilesystemSnapshotManifest; after: FilesystemSnapshotManifest },
  branch?: string,
): Promise<UiWorkspaceChanges> {
  const paths = [...new Set([
    ...Object.keys(pair.before.files),
    ...Object.keys(pair.after.files),
    ...Object.keys(pair.before.directories),
    ...Object.keys(pair.after.directories),
  ])].sort((left, right) => left.localeCompare(right));
  const files: UiChangedFile[] = [];
  for (const path of paths) {
    const before = pair.before.files[path];
    const after = pair.after.files[path];
    if (!before && !after) {
      const beforeDirectory = pair.before.directories[path];
      const afterDirectory = pair.after.directories[path];
      if (!beforeDirectory && !afterDirectory) continue;
      if (beforeDirectory && afterDirectory && beforeDirectory.mode === afterDirectory.mode) continue;
      const status: ChangeStatus = !beforeDirectory ? "added" : !afterDirectory ? "deleted" : "modified";
      files.push({
        path,
        ...describe(path),
        status,
        added: 0,
        removed: 0,
        note: "Directory metadata changed; no textual content is available.",
      });
      continue;
    }
    if (before && after && before.hash === after.hash && before.mode === after.mode) continue;
    const status: ChangeStatus = !before ? "added" : !after ? "deleted" : "modified";
    const contentChanged = !before || !after || before.hash !== after.hash;
    const unavailableReason = after?.unavailableReason ?? before?.unavailableReason;
    files.push({
      path,
      ...describe(path),
      status,
      added: status === "deleted" || !contentChanged ? 0 : await filesystemLineCount(pair.after.cwd, after),
      removed: status === "added" || !contentChanged ? 0 : await filesystemLineCount(pair.before.cwd, before),
      ...(unavailableReason ? { note: unavailableReason } : {}),
    });
  }
  const omittedFileCount = pair.before.omittedFileCount + pair.after.omittedFileCount;
  const omissionReasons = [...new Set([...pair.before.omissionReasons, ...pair.after.omissionReasons])];
  const complete = pair.before.complete && pair.after.complete;
  return {
    ...(branch ? { branch } : {}),
    files,
    fileCount: files.length,
    completeness: complete ? "complete" : "partial",
    ...(complete ? {} : {
      omittedFileCount,
      incompleteReason: omissionReasons.length > 0
        ? `Snapshot coverage is partial: ${omissionReasons.join("; ")}.`
        : "Snapshot coverage is partial; some workspace files may be omitted.",
    }),
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
    proposedMessage: proposeMessage(files),
  };
}

async function filesystemManifests(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
    }
  };
  await walk(root);
  return result;
}

/** Reclaims blobs left by a crashed plain-folder snapshot publication. */
export async function gcFilesystemSnapshotBlobs(cwd?: string): Promise<void> {
  const workspaceRoots = cwd
    ? [join(FILESYSTEM_SNAPSHOT_ROOT, filesystemWorkspaceKey(await realpath(cwd).catch(() => resolve(cwd))))]
    // A process-wide maintenance hook may be used during startup before a
    // workspace is selected. Enumerate each namespaced workspace independently
    // so one workspace's manifest set cannot hide another workspace's blobs.
    : (await readdir(FILESYSTEM_SNAPSHOT_ROOT, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(FILESYSTEM_SNAPSHOT_ROOT, entry.name));
  await Promise.all(workspaceRoots.map(async (workspaceRoot) => {
    const referenced = new Set<string>();
    for (const path of await filesystemManifests(join(workspaceRoot, "checkpoints"))) {
      const manifest = await readFile(path, "utf8").then((value) => JSON.parse(value) as Partial<FilesystemSnapshotManifest>).catch(() => undefined);
      if (!manifest?.files || typeof manifest.files !== "object") continue;
      for (const file of Object.values(manifest.files)) {
        if (file && typeof file === "object" && typeof (file as FilesystemSnapshotFile).hash === "string") referenced.add((file as FilesystemSnapshotFile).hash);
      }
    }
    const blobRoot = join(workspaceRoot, "blobs");
    const blobs = await readdir(blobRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(blobs
      .filter((entry) => entry.isFile() && !referenced.has(entry.name))
      .map((entry) => rm(join(blobRoot, entry.name), { force: true })));
  }));
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/** Rejects traversal and symlink escapes before any path is passed to Git. */
export async function assertWorkspacePath(cwd: string, path: string): Promise<void> {
  const target = resolve(cwd, path);
  if (!within(cwd, target)) throw new Error("Path is outside the workspace.");
  const rootReal = await realpath(cwd);
  let probe = target;
  while (true) {
    try {
      if (!within(rootReal, await realpath(probe))) throw new Error("Path is outside the workspace.");
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "Path is outside the workspace.") throw error;
      if (probe === cwd) throw error;
      probe = dirname(probe);
    }
  }
}

// Diff ceilings keep generated files from turning one review into an unbounded IPC payload.
export const MAX_DIFF_BYTES = 1_024 * 1_024;
export const MAX_DIFF_LINES = 10_000;
export const MAX_DIFF_HUNKS = 120;

/** Terminals we know how to launch. */
export const KNOWN_TERMINALS: ReadonlyArray<UiTerminal> = [
  { id: "ghostty", name: "Ghostty" },
  { id: "iterm", name: "iTerm" },
  { id: "warp", name: "Warp" },
  { id: "kitty", name: "Kitty" },
  { id: "alacritty", name: "Alacritty" },
  { id: "terminal", name: "Terminal" },
];

export type GitRunner = (cwd: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => Promise<string>;
export type SnapshotGitRunner = (
  cwd: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

export async function runGitCommand(
  cwd: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  timeout = 10_000,
): Promise<string> {
  const { stdout } = await execFileAsync(gitExecutable(), ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer,
    timeout,
    signal,
    env,
    windowsHide: true,
  });
  return stdout;
}

const git: GitRunner = runGitCommand;

function statusFromCode(code: string): ChangeStatus {
  if (code.includes("?")) return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function describe(path: string): Pick<UiChangedFile, "name" | "directory"> {
  const directory = dirname(path);
  return { name: basename(path), directory: directory === "." ? "" : directory };
}

/**
 * `git status --porcelain -z` emits `XY path\0`, and for renames a second
 * `\0`-terminated field holding the original path.
 */
interface ParsedStatus { status: ChangeStatus; staged: boolean }

function parseStatus(stdout: string): Map<string, ParsedStatus> {
  const statuses = new Map<string, ParsedStatus>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) continue;
    statuses.set(path, { status: statusFromCode(code), staged: code !== "??" && code[0] !== " " });
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return statuses;
}

/**
 * `git diff --numstat -z` emits `added\tremoved\tpath\0`; for renames the path
 * field is empty and the old and new paths follow as their own records.
 */
function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(tokens[index] ?? "");
    if (!match) continue;
    let path = match[3];
    if (!path) {
      index += 2;
      path = tokens[index] ?? "";
      if (!path) continue;
    }
    counts.set(path, {
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return counts;
}

const UNTRACKED_STAT_LIMIT = 500;

export interface UntrackedStatsOptions {
  /** Never read a complete large file just to produce a review statistic. */
  maxBytes?: number;
  onBytesRead?: (bytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Counts only a bounded UTF-8 text prefix. NUL bytes identify binary content,
 * for which line statistics are intentionally omitted. This keeps status scans
 * from loading large artifacts into memory or serially decoding them in full.
 */
export async function countUntrackedLines(
  cwd: string,
  path: string,
  options: UntrackedStatsOptions = {},
): Promise<number> {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  try {
    const file = await stat(join(cwd, path));
    if (!file.isFile() || file.size > maxBytes) return 0;
    const handle = await open(join(cwd, path), "r");
    try {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
      let offset = 0;
      let lines = 0;
      let pending = 0;
      while (offset < file.size) {
        if (options.signal?.aborted) return 0;
        const length = Math.min(buffer.length, file.size - offset);
        const result = await handle.read(buffer, 0, length, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
        options.onBytesRead?.(result.bytesRead);
        const chunk = buffer.subarray(0, result.bytesRead);
        if (chunk.includes(0)) return 0;
        for (const byte of chunk) {
          if (byte === 10) lines += 1;
          pending = byte;
        }
      }
      return file.size === 0 ? 0 : lines + (pending === 10 ? 0 : 1);
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

/** A starting point for the commit box — the shape of the change, not a summary of it. */
function proposeMessage(files: UiChangedFile[]): string | undefined {
  if (files.length === 0) return undefined;
  const areas = [...new Set(files.map((file) => file.directory.split("/")[0] || file.name))];
  const scope = areas.length === 1 ? areas[0] : `${areas.length} areas`;
  const subject = files.length === 1 ? files[0].name : `${files.length} files`;
  return `chore(${scope}): update ${subject}`;
}

export interface ProjectGitState {
  changes: UiWorkspaceChanges;
  workspace: WorkspaceInfo;
  branch?: string;
}

export interface ProjectScanOptions {
  runGit?: GitRunner;
  untrackedStats?: UntrackedStatsOptions;
  onGitCommand?: () => void;
  signal?: AbortSignal;
  throwOnError?: boolean;
  worktreeParent?: string;
}

export function emptyProjectGitState(cwd: string): ProjectGitState {
  return {
    changes: EMPTY_CHANGES,
    workspace: {
      root: cwd,
      isRepo: false,
      isDirty: false,
      worktrees: [],
      refs: [],
      worktreeParent: resolveWorktreeParent(cwd),
    },
  };
}

export interface WorkspaceSnapshot {
  /** Stable namespaced ref persisted in the turn checkpoint. */
  id: string;
  ref: string;
  /** The tree object addressed by the ref, useful for diagnostics and tests. */
  treeId: string;
  /** Capture location/identity, used to clean provisional refs after a switch. */
  cwd?: string;
  sessionId?: string;
  turnId?: string;
  phase?: "before" | "after";
  /** Plain folders use the bounded filesystem content-addressed backend. */
  backend?: "git" | "filesystem";
  /** Plain-folder snapshots are restorable only when the bounded scan completed. */
  complete?: boolean;
  /** HEAD when the tree was read ("" while unborn); Git snapshots only. */
  head?: string;
  headBranch?: string;
}

export interface WorkspaceSnapshotOptions {
  /** Session/turn namespace. It must not contain an empty or `..` component. */
  namespace: string;
  phase: "before" | "after";
  runGit?: SnapshotGitRunner;
}

export interface SnapshotDiffOptions {
  branch?: string;
  runGit?: GitRunner;
  expected?: SnapshotRefExpectation;
}

export interface SnapshotRefExpectation {
  sessionId: string;
  turnId: string;
}

export interface SnapshotPageOptions extends SnapshotRefExpectation {
  branch?: string;
  cursor?: string;
  limit?: number;
  runGit?: GitRunner;
  /** Narrows the full list to the turn's own files before it is paged. */
  attribute?(changes: UiWorkspaceChanges): Promise<UiWorkspaceChanges>;
}

const SNAPSHOT_GIT_BUFFER = 64 * 1024 * 1024;

function snapshotRef(namespace: string, phase: WorkspaceSnapshotOptions["phase"]): string {
  return namespacedSnapshotRef(namespace, phase);
}

/**
 * Captures the complete worktree into a temporary Git index and publishes only
 * its tree as a namespaced ref. The user's index and worktree are never used as
 * write targets. `git add -A` also folds tracked, deleted, and non-ignored
 * untracked files into the immutable tree, so a pre-existing dirty base is
 * naturally part of the before snapshot and drops out of the later diff.
 */
export async function createWorkspaceSnapshot(
  cwd: string,
  options: WorkspaceSnapshotOptions,
): Promise<WorkspaceSnapshot> {
  const runGit = options.runGit ?? git;
  const ref = snapshotRef(options.namespace, options.phase);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tau-turn-snapshot-"));
  const temporaryIndex = join(temporaryDirectory, "index");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_OPTIONAL_LOCKS: "0",
  };
  const run = (args: string[], maxBuffer = SNAPSHOT_GIT_BUFFER): Promise<string> =>
    runGit(cwd, args, maxBuffer, undefined, env);
  let isGitWorkspace = false;
  try {
    const inside = (await run(["rev-parse", "--is-inside-work-tree"])).trim();
    isGitWorkspace = true;
    if (inside !== "true") throw new Error("Git workspace snapshots are unavailable for bare repositories.");
    const head = (await run(["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
    const headBranch = (await run(["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")).trim();
    await run(head ? ["read-tree", head] : ["read-tree", "--empty"]);
    await run(["add", "-A"]);
    const treeId = (await run(["write-tree"])).trim();
    if (!/^[0-9a-f]{40,64}$/iu.test(treeId)) throw new Error("Git did not return a valid workspace snapshot tree.");
    // Publish once. A retry for the same turn may observe the existing tree,
    // but a ref that already points somewhere else must never be overwritten:
    // the IDs stored in a checkpoint are immutable historical boundaries.
    const existing = (await run(["rev-parse", "--verify", ref]).catch(() => "")).trim();
    if (existing && existing !== treeId) throw new Error(`Snapshot ref ${ref} already points to another tree.`);
    if (!existing) {
      try {
        // An all-zero old value makes creation conditional and remains valid
        // for both SHA-1 and SHA-256 repositories.
        await run(["update-ref", ref, treeId, "0".repeat(treeId.length)]);
      } catch (error) {
        // Another process may have won the create race. Accept it only when it
        // published the exact same tree; otherwise preserve the first value.
        const published = (await run(["rev-parse", "--verify", ref]).catch(() => "")).trim();
        if (published !== treeId) throw error;
      }
    }
    return { id: ref, ref, treeId, cwd, backend: "git", complete: true, head, ...(headBranch ? { headBranch } : {}) };
  } catch (error) {
    // A regular folder is a supported Workspace Kit workspace too. Only fall
    // back before Git has identified a worktree; errors after that boundary
    // must remain visible and must never produce a misleading filesystem
    // checkpoint.
    if (isGitWorkspace) throw error;
    return createFilesystemSnapshot(cwd, options, ref);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Turn-specific wrapper that makes the persisted ref name derivation explicit. */
export async function createTurnWorkspaceSnapshot(
  cwd: string,
  sessionId: string,
  turnId: string,
  phase: "before" | "after",
  runGit?: SnapshotGitRunner,
): Promise<WorkspaceSnapshot> {
  const snapshot = await createWorkspaceSnapshot(cwd, {
    namespace: `${sanitizeTurnSnapshotComponent(sessionId)}/${sanitizeTurnSnapshotComponent(turnId)}`,
    phase,
    ...(runGit ? { runGit } : {}),
  });
  return { ...snapshot, cwd, sessionId, turnId, phase };
}

function validObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value.trim());
}

/**
 * Resolves both exact namespaced refs and verifies that each ref currently
 * addresses a tree. This is the restore/diff trust boundary: arbitrary refs,
 * swapped phases, and foreign session snapshots are rejected before Git sees
 * a historical operation.
 */
export async function validateWorkspaceSnapshotRefs(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  expected: SnapshotRefExpectation,
  runGit: GitRunner = git,
): Promise<{ beforeTreeId: string; afterTreeId: string }> {
  const expectedBefore = turnSnapshotRef(expected.sessionId, expected.turnId, "before");
  const expectedAfter = turnSnapshotRef(expected.sessionId, expected.turnId, "after");
  if (beforeSnapshotId !== expectedBefore || afterSnapshotId !== expectedAfter) {
    throw new Error("Turn checkpoint snapshot refs do not match their session and turn.");
  }
  const filesystem = await filesystemSnapshotPair(cwd, beforeSnapshotId, afterSnapshotId);
  if (filesystem) return { beforeTreeId: filesystem.before.treeId, afterTreeId: filesystem.after.treeId };
  const [beforeTree, afterTree, beforeType, afterType] = await Promise.all([
    runGit(cwd, ["rev-parse", "--verify", `${expectedBefore}^{tree}`]),
    runGit(cwd, ["rev-parse", "--verify", `${expectedAfter}^{tree}`]),
    runGit(cwd, ["cat-file", "-t", expectedBefore]),
    runGit(cwd, ["cat-file", "-t", expectedAfter]),
  ]);
  const beforeTreeId = beforeTree.trim();
  const afterTreeId = afterTree.trim();
  if (!validObjectId(beforeTreeId) || !validObjectId(afterTreeId)
    || beforeType.trim() !== "tree" || afterType.trim() !== "tree") {
    throw new Error("Turn checkpoint snapshot refs are missing or do not address trees.");
  }
  return { beforeTreeId, afterTreeId };
}

/**
 * Restore/offer trust boundary. Unlike the structural validator used by
 * historical diff and GC paths, this also verifies every plain-folder blob
 * and rejects incomplete coverage or missing mode metadata.
 */
export async function validateRestorableWorkspaceSnapshotRefs(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  expected: SnapshotRefExpectation,
  runGit: GitRunner = git,
): Promise<{ beforeTreeId: string; afterTreeId: string }> {
  const trees = await validateWorkspaceSnapshotRefs(cwd, beforeSnapshotId, afterSnapshotId, expected, runGit);
  const filesystem = await filesystemSnapshotPair(cwd, beforeSnapshotId, afterSnapshotId);
  if (filesystem) await assertFilesystemRestoreable(cwd, filesystem, "Selected checkpoint");
  return trees;
}

export interface WorkspaceRestoreOptions {
  /** The checkpoint whose `after` tree becomes the live workspace. */
  target: SnapshotRefExpectation;
  /** A complete pair captured immediately before restore, used for rollback. */
  rollback: SnapshotRefExpectation;
  runGit?: GitRunner;
  /** Durable phase hook; called before/inside/after the destructive apply. */
  onPhase?: (phase: "apply-started" | "cleaned" | "applied" | "rolling-back") => void | Promise<void>;
}

/**
 * Replays one immutable checkpoint into the live workspace with a verified
 * rollback pair. The caller must create and durably retain that pair before
 * invoking this function. Any failed target operation is followed by a best
 * effort rollback; an error is thrown if either step fails.
 */
export async function restoreWorkspaceSnapshot(
  cwd: string,
  targetAfterSnapshotId: string,
  options: WorkspaceRestoreOptions,
): Promise<void> {
  const targetBefore = turnSnapshotRef(options.target.sessionId, options.target.turnId, "before");
  const targetAfter = turnSnapshotRef(options.target.sessionId, options.target.turnId, "after");
  const rollbackBefore = turnSnapshotRef(options.rollback.sessionId, options.rollback.turnId, "before");
  const rollbackAfter = turnSnapshotRef(options.rollback.sessionId, options.rollback.turnId, "after");
  if (targetAfterSnapshotId !== targetAfter) {
    throw new Error("The selected checkpoint snapshot does not match its session and turn.");
  }
  const runGit = options.runGit ?? git;
  const [targetTrees, rollbackTrees] = await Promise.all([
    validateWorkspaceSnapshotRefs(cwd, targetBefore, targetAfter, options.target, runGit),
    validateWorkspaceSnapshotRefs(cwd, rollbackBefore, rollbackAfter, options.rollback, runGit),
  ]);
  const [targetFilesystem, rollbackFilesystem] = await Promise.all([
    filesystemSnapshotPair(cwd, targetBefore, targetAfter),
    filesystemSnapshotPair(cwd, rollbackBefore, rollbackAfter),
  ]);
  if (Boolean(targetFilesystem) !== Boolean(rollbackFilesystem)) {
    throw new Error("The checkpoint and rollback snapshots use different workspace backends.");
  }
  if (targetFilesystem && rollbackFilesystem) {
    await assertFilesystemRestoreable(cwd, targetFilesystem, "Selected checkpoint");
    await assertFilesystemRestoreable(cwd, rollbackFilesystem, "Restore backup");
  }

  const applyGit = async (treeId: string, notify = true): Promise<void> => {
    // `clean -fd` removes only non-ignored untracked files, matching the
    // capture boundary. Ignored folders (for example node_modules) are never
    // removed by a restore operation.
    await runGit(cwd, ["clean", "-fd", "--"], SNAPSHOT_GIT_BUFFER);
    if (notify) await options.onPhase?.("cleaned");
    await runGit(cwd, ["read-tree", "--reset", "-u", treeId], SNAPSHOT_GIT_BUFFER);
  };
  const apply = targetFilesystem && rollbackFilesystem
    ? () => applyFilesystemSnapshot(cwd, targetFilesystem.after)
    : () => applyGit(targetTrees.afterTreeId);
  const rollback = targetFilesystem && rollbackFilesystem
    ? () => applyFilesystemSnapshot(cwd, rollbackFilesystem.after)
    : () => applyGit(rollbackTrees.afterTreeId, false);
  try {
    await options.onPhase?.("apply-started");
    await apply();
    await options.onPhase?.("applied");
  } catch (error) {
    await Promise.resolve(options.onPhase?.("rolling-back")).catch(() => undefined);
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Workspace restore failed and rollback could not be completed.", { cause: rollbackError });
    }
    throw new Error(`Workspace restore failed; the original workspace was restored. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function snapshotPairShape(
  beforeSnapshotId: string,
  afterSnapshotId: string,
): { namespace: string } | undefined {
  if (!isTurnSnapshotId(beforeSnapshotId) || !isTurnSnapshotId(afterSnapshotId)) return undefined;
  const beforeParts = beforeSnapshotId.split("/");
  const afterParts = afterSnapshotId.split("/");
  const beforePhase = beforeParts.at(-1);
  const afterPhase = afterParts.at(-1);
  const beforeNamespace = beforeParts.slice(3, -1).join("/");
  const afterNamespace = afterParts.slice(3, -1).join("/");
  if (beforePhase !== "before" || afterPhase !== "after" || beforeNamespace !== afterNamespace) return undefined;
  return { namespace: beforeNamespace };
}

/**
 * Forks inherit the conversation tree, but their checkpoint refs must live in
 * the new session namespace. Copy the immutable tree targets atomically and
 * remove only refs created by this operation if the second phase fails.
 */
export async function cloneTurnCheckpointRefs(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
): Promise<void> {
  const created: Array<{ id: string; treeId: string }> = [];
  try {
    for (const checkpoint of checkpoints) {
      if (checkpoint.sessionId !== sourceSessionId
        || checkpoint.beforeSnapshotId !== turnSnapshotRef(sourceSessionId, checkpoint.turnId, "before")
        || checkpoint.afterSnapshotId !== turnSnapshotRef(sourceSessionId, checkpoint.turnId, "after")) {
        throw new Error("Cannot clone a checkpoint with a foreign snapshot namespace.");
      }
      const trees = await validateWorkspaceSnapshotRefs(
        cwd,
        checkpoint.beforeSnapshotId,
        checkpoint.afterSnapshotId,
        { sessionId: sourceSessionId, turnId: checkpoint.turnId },
        runGit,
      );
      const sourceFilesystem = await filesystemSnapshotPair(
        cwd,
        checkpoint.beforeSnapshotId,
        checkpoint.afterSnapshotId,
      );
      for (const [phase, treeId] of [["before", trees.beforeTreeId], ["after", trees.afterTreeId]] as const) {
        const id = turnSnapshotRef(targetSessionId, checkpoint.turnId, phase);
        if (sourceFilesystem) {
          if (await cloneFilesystemSnapshot(
            cwd,
            turnSnapshotRef(sourceSessionId, checkpoint.turnId, phase),
            id,
            treeId,
          )) created.push({ id, treeId });
          continue;
        }
        const existing = (await runGit(cwd, ["rev-parse", "--verify", id]).catch(() => "")).trim();
        if (existing && existing !== treeId) throw new Error(`Fork snapshot ref ${id} already points to another tree.`);
        if (existing) {
          const existingType = (await runGit(cwd, ["cat-file", "-t", id]).catch(() => "")).trim();
          if (existingType !== "tree") throw new Error(`Fork snapshot ref ${id} does not address a tree.`);
        }
        if (!existing) {
          await runGit(cwd, ["update-ref", id, treeId, "0".repeat(treeId.length)]);
          created.push({ id, treeId });
        }
      }
      await validateWorkspaceSnapshotRefs(
        cwd,
        turnSnapshotRef(targetSessionId, checkpoint.turnId, "before"),
        turnSnapshotRef(targetSessionId, checkpoint.turnId, "after"),
        { sessionId: targetSessionId, turnId: checkpoint.turnId },
        runGit,
      );
    }
  } catch (error) {
    await Promise.all(created.map(({ id, treeId }) => deleteWorkspaceSnapshot(
      cwd,
      id,
      { sessionId: targetSessionId, turnId: id.split("/").at(-2) ?? "", phase: id.endsWith("/after") ? "after" : "before", treeId },
      runGit,
    )));
    throw error;
  }
}

/** Removes only target refs whose trees match the source fork copy. */
export async function cleanupClonedTurnCheckpointRefs(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
  /** Already committed target entries survive a failed/retried fork. */
  preserve: readonly StoredTurnCheckpoint[] = [],
): Promise<void> {
  const preserved = new Set(preserve.flatMap((checkpoint) => [checkpoint.beforeSnapshotId, checkpoint.afterSnapshotId]));
  await Promise.all(checkpoints.map(async (checkpoint) => {
    if (checkpoint.sessionId !== sourceSessionId) return;
    const source = await validateWorkspaceSnapshotRefs(
      cwd,
      checkpoint.beforeSnapshotId,
      checkpoint.afterSnapshotId,
      { sessionId: sourceSessionId, turnId: checkpoint.turnId },
      runGit,
    ).catch(() => undefined);
    const before = turnSnapshotRef(targetSessionId, checkpoint.turnId, "before");
    const after = turnSnapshotRef(targetSessionId, checkpoint.turnId, "after");
    // Normally the source pair supplies tree IDs for compare-and-delete. If a
    // source session was removed during failure recovery, the target refs are
    // still uncommitted by definition; remove only the exact target namespace
    // while preserving every durable target entry supplied by `preserve`.
    // This avoids leaving orphaned fork refs merely because the source cleanup
    // raced the recovery path.
    if (!preserved.has(before)) {
      await deleteWorkspaceSnapshot(
        cwd,
        before,
        source
          ? { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "before", treeId: source.beforeTreeId }
          : { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "before" },
        runGit,
      );
    }
    if (!preserved.has(after)) {
      await deleteWorkspaceSnapshot(
        cwd,
        after,
        source
          ? { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "after", treeId: source.afterTreeId }
          : { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "after" },
        runGit,
      );
    }
  }));
}

/** Delete only a verified, namespaced snapshot ref. The real index/worktree are untouched. */
export async function deleteWorkspaceSnapshot(
  cwd: string,
  snapshotId: string,
  expected?: SnapshotRefExpectation & { phase?: "before" | "after"; treeId?: string },
  runGit: GitRunner = git,
): Promise<void> {
  if (!isTurnSnapshotId(snapshotId)) return;
  if (expected) {
    const phase = expected.phase ?? (snapshotId.endsWith("/after") ? "after" : "before");
    if (snapshotId !== turnSnapshotRef(expected.sessionId, expected.turnId, phase)) return;
    if (expected.treeId) {
      const current = (await runGit(cwd, ["rev-parse", "--verify", snapshotId]).catch(() => "")).trim();
      if (current && current !== expected.treeId) return;
    }
  }
  const filesystem = await readFilesystemSnapshot(cwd, snapshotId);
  if (filesystem) {
    if (expected?.treeId && filesystem.treeId !== expected.treeId) return;
    await rm(filesystemManifestPath(filesystem.cwd, snapshotId), { force: true });
    return;
  }
  await runGit(cwd, ["update-ref", "-d", snapshotId]).catch(() => undefined);
}

/** Session/pruning hook: remove all refs owned by a completed checkpoint. */
export async function cleanupTurnCheckpointRefs(
  cwd: string,
  checkpoints: readonly SnapshotRefExpectation[],
  runGit: GitRunner = git,
): Promise<void> {
  for (const checkpoint of checkpoints) {
    await deleteWorkspaceSnapshot(cwd, turnSnapshotRef(checkpoint.sessionId, checkpoint.turnId, "before"), checkpoint, runGit);
    await deleteWorkspaceSnapshot(cwd, turnSnapshotRef(checkpoint.sessionId, checkpoint.turnId, "after"), { ...checkpoint, phase: "after" }, runGit);
  }
}

/** Garbage-collect every checkpoint ref owned by a session file that was deleted. */
export async function cleanupTurnCheckpointSessionRefs(
  cwd: string,
  sessionId: string,
  runGit: GitRunner = git,
): Promise<void> {
  const prefix = `refs/tau/checkpoints/${sanitizeTurnSnapshotComponent(sessionId)}/`;
  const refs = (await runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => ""))
    .split("\n")
    .map((ref) => ref.trim())
    .filter((ref) => isTurnSnapshotId(ref));
  await Promise.all(refs.map((ref) => runGit(cwd, ["update-ref", "-d", ref]).catch(() => undefined)));
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  await rm(join(FILESYSTEM_SNAPSHOT_ROOT, filesystemWorkspaceKey(canonicalCwd), "checkpoints", sanitizeTurnSnapshotComponent(sessionId)), {
    recursive: true,
    force: true,
  });
  await gcFilesystemSnapshotBlobs(cwd);
}

/**
 * How long a snapshot ref survives an orphan sweep whatever the journals say.
 * Publishing the refs and appending the durable entry are two steps, and no
 * lease spans the gap once capture has released; a sweep that lands inside it
 * would otherwise read a complete checkpoint as garbage.
 */
export const CHECKPOINT_REF_GRACE_MS = 10 * 60 * 1_000;

export interface CheckpointRefSweepOptions {
  /** Zero disables the age backstop, leaving the journals as the only roots. */
  graceMs?: number;
  now?: number;
}

/**
 * The subset of `refs` written less than `graceMs` ago. Git records no creation
 * time for a ref that names a tree, so this reads the loose ref file. A packed
 * ref has none and is never young — packing is itself a later operation.
 */
async function recentSnapshotRefs(
  cwd: string,
  refs: readonly string[],
  runGit: GitRunner,
  options: CheckpointRefSweepOptions,
): Promise<Set<string>> {
  const graceMs = options.graceMs ?? CHECKPOINT_REF_GRACE_MS;
  const recent = new Set<string>();
  if (graceMs <= 0 || refs.length === 0) return recent;
  const now = options.now ?? Date.now();
  const commonDir = (await runGit(cwd, ["rev-parse", "--git-common-dir"]).catch(() => "")).trim();
  if (!commonDir) return recent;
  const root = resolve(cwd, commonDir);
  await Promise.all(refs.map(async (ref) => {
    const stamp = await stat(join(root, ref)).catch(() => undefined);
    if (stamp && now - stamp.mtimeMs < graceMs) recent.add(ref);
  }));
  return recent;
}

/** The same backstop for the filesystem-snapshot fallback, whose manifests are plain files. */
async function recentManifests(
  paths: readonly string[],
  options: CheckpointRefSweepOptions,
): Promise<Set<string>> {
  const graceMs = options.graceMs ?? CHECKPOINT_REF_GRACE_MS;
  const recent = new Set<string>();
  if (graceMs <= 0 || paths.length === 0) return recent;
  const now = options.now ?? Date.now();
  await Promise.all(paths.map(async (path) => {
    const stamp = await stat(path).catch(() => undefined);
    if (stamp && now - stamp.mtimeMs < graceMs) recent.add(path);
  }));
  return recent;
}

/** A pair the ref listing already shows as two trees needs no Git call of its own. */
function listedTreePair(objects: SnapshotRefObjects, before: string, after: string): boolean {
  return [before, after].every((ref) => {
    const object = objects.get(ref);
    return object?.type === "tree" && object.id !== undefined && validObjectId(object.id);
  });
}

type SnapshotRefObjects = Map<string, { id?: string; type?: string }>;

/** Snapshot refs under `prefix` with their objects; names alone when Git cannot describe every object. */
async function snapshotRefObjects(cwd: string, prefix: string, runGit: GitRunner): Promise<SnapshotRefObjects> {
  const objects: SnapshotRefObjects = new Map();
  const listed = await runGit(cwd, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)", prefix]).catch(() => undefined);
  const lines = listed ?? await runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => "");
  for (const line of lines.split("\n")) {
    const [ref, id, type] = line.trim().split(" ");
    if (ref && isTurnSnapshotId(ref)) objects.set(ref, listed === undefined ? {} : { id, type });
  }
  return objects;
}

/**
 * Crash recovery for the two-phase checkpoint write. A process can publish
 * immutable trees and die before its session custom entry is appended; those
 * refs are not discoverable by the UI and must not live forever. Keep only
 * complete, namespace-validated pairs represented by the durable entries.
 */
export async function cleanupOrphanTurnCheckpointRefs(
  cwd: string,
  sessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
  backups: readonly TurnRestoreBackup[] = [],
  options: CheckpointRefSweepOptions = {},
): Promise<void> {
  const prefix = `refs/tau/checkpoints/${sanitizeTurnSnapshotComponent(sessionId)}/`;
  // Every ref's object comes with the listing, so a pair of trees costs no Git call of its own:
  // this runs before each thread opens, and a call per checkpoint made a long thread slow to open.
  const objects = await snapshotRefObjects(cwd, prefix, runGit);
  const refs = [...objects.keys()];
  const refSet = new Set(refs);
  const valid = new Set<string>();
  const keepPair = async (turnId: string): Promise<void> => {
    const before = turnSnapshotRef(sessionId, turnId, "before");
    const after = turnSnapshotRef(sessionId, turnId, "after");
    // A durable entry is valid only when both deterministic refs still
    // exist and both resolve to trees in the expected namespace. This also
    // removes half-written pairs left by a crash or a failed ref update.
    if (!refSet.has(before) || !refSet.has(after)) return;
    if (!listedTreePair(objects, before, after)) await validateWorkspaceSnapshotRefs(cwd, before, after, { sessionId, turnId }, runGit);
    valid.add(before);
    valid.add(after);
  };
  for (const checkpoint of checkpoints) {
    if (checkpoint.sessionId !== sessionId) continue;
    // Malformed or incomplete persisted entries are ignored; their refs are
    // intentionally treated as orphaned and removed below.
    await keepPair(checkpoint.turnId).catch(() => undefined);
  }
  for (const backup of backups) {
    if (backup.sessionId !== sessionId) continue;
    // A backup with a missing or malformed pair is not recoverable and must
    // not keep an orphaned ref alive.
    await keepPair(backup.turnId).catch(() => undefined);
  }
  const doomed = refs.filter((ref) => !valid.has(ref));
  const recent = await recentSnapshotRefs(cwd, doomed, runGit, options);
  await Promise.all(doomed.filter((ref) => !recent.has(ref)).map((ref) => runGit(cwd, ["update-ref", "-d", ref]).catch(() => undefined)));
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const sessionDirectory = join(FILESYSTEM_SNAPSHOT_ROOT, filesystemWorkspaceKey(canonicalCwd), "checkpoints", sanitizeTurnSnapshotComponent(sessionId));
  const filesystemRefs = await filesystemManifests(sessionDirectory);
  const validFilesystem = new Set<string>();
  // Without manifests nothing can be orphaned; a Git checkout keeps none.
  if (filesystemRefs.length > 0) for (const checkpoint of checkpoints) {
    if (checkpoint.sessionId !== sessionId) continue;
    const before = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(sessionId, checkpoint.turnId, "before"));
    const after = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(sessionId, checkpoint.turnId, "after"));
    if (before && after) {
      validFilesystem.add(filesystemManifestPath(canonicalCwd, before.id));
      validFilesystem.add(filesystemManifestPath(canonicalCwd, after.id));
    }
  }
  if (filesystemRefs.length > 0) for (const backup of backups) {
    if (backup.sessionId !== sessionId) continue;
    const before = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(sessionId, backup.turnId, "before"));
    const after = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(sessionId, backup.turnId, "after"));
    if (before && after) {
      validFilesystem.add(filesystemManifestPath(canonicalCwd, before.id));
      validFilesystem.add(filesystemManifestPath(canonicalCwd, after.id));
    }
  }
  const doomedManifests = filesystemRefs.filter((path) => !validFilesystem.has(path));
  const recentManifestPaths = await recentManifests(doomedManifests, options);
  await Promise.all(doomedManifests.filter((path) => !recentManifestPaths.has(path)).map((path) => rm(path, { force: true })));
  await gcFilesystemSnapshotBlobs(cwd);
}

export interface LiveCheckpointSession {
  sessionId: string;
  checkpoints: readonly StoredTurnCheckpoint[];
  backups?: readonly TurnRestoreBackup[];
  /** Pending restore transactions own rollback refs until recovery commits. */
  restoreTransactions?: readonly TurnRestoreTransaction[];
  /** Canonical workspace used to scope GC when linked worktrees share refs. */
  cwd?: string;
}

/**
 * Startup/pruning sweep for one checkout. The caller holds the workspace lease
 * for the complete scan. All persisted sessions are considered before a ref is
 * removed, including sessions which are not currently loaded in memory.
 */
export async function cleanupCheckpointRefsForLiveSessions(
  cwd: string,
  sessions: readonly LiveCheckpointSession[],
  runGit: GitRunner = git,
  options: CheckpointRefSweepOptions = {},
): Promise<void> {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const liveSessionIds = (owners: readonly { sessionId: string }[]): Set<string> => new Set(owners.map((owner) => {
    try { return sanitizeTurnSnapshotComponent(owner.sessionId); } catch { return ""; }
  }).filter(Boolean));
  // This first observation covers writers that were already active when the
  // sweep began. It is deliberately repeated after the ref enumeration: a
  // sibling can acquire its independent linked-worktree lease in between the
  // first observation and `for-each-ref`, which is the dangerous TOCTOU gap.
  const protectedSessionIds = liveSessionIds(await listLiveWorkspaceLeaseSessions());
  // Git linked worktrees share one ref namespace but intentionally do not
  // share a mutation lease. Restrict this sweep to sessions belonging to the
  // current canonical checkout; otherwise a quiet worktree could delete a
  // live writer's provisional ref in its sibling. Older callers without cwd
  // retain the legacy all-session behavior for compatibility.
  const scopedSessions = await Promise.all(sessions.map(async (session) => {
    if (!session.cwd) return session;
    const sessionCwd = await realpath(session.cwd).catch(() => resolve(session.cwd!));
    return sessionCwd === canonicalCwd ? session : undefined;
  })).then((items) => items.filter((session): session is LiveCheckpointSession => Boolean(session)));
  const scopedSessionIds = new Set(scopedSessions.flatMap((session) => {
    try { return [sanitizeTurnSnapshotComponent(session.sessionId)]; } catch { return []; }
  }));
  const knownSessionIds = new Set(sessions.flatMap((session) => {
    try { return [sanitizeTurnSnapshotComponent(session.sessionId)]; } catch { return []; }
  }));
  const prefix = "refs/tau/checkpoints/";
  // Every checkpoint of every session is checked while the workspace's lease is held; one listing keeps that short.
  const objects = await snapshotRefObjects(cwd, prefix, runGit);
  const refs = [...objects.keys()];
  for (const sessionId of liveSessionIds(await listLiveWorkspaceLeaseSessions())) protectedSessionIds.add(sessionId);
  const refsForWorkspace = refs.filter((ref) => {
    const sessionId = ref.split("/")[3];
    // If every caller supplied a workspace identity, retain known sessions in
    // sibling linked worktrees but reclaim refs for sessions absent from the
    // persisted index. The latter is the startup/pruning path for an offline
    // deletion; leaving them forever would leak immutable trees. A missing cwd
    // in any legacy record falls back to the conservative all-session behavior.
    // Keep every ref in a live writer's session namespace out of this sweep.
    // The writer may have published one phase but not its durable entry yet;
    // a later pass after lease release can reclaim it safely.
    if (protectedSessionIds.has(sessionId)) return false;
    return sessions.some((session) => !session.cwd)
      || scopedSessionIds.has(sessionId)
      || !knownSessionIds.has(sessionId);
  });
  const refSet = new Set(refsForWorkspace);
  const valid = new Set<string>();
  for (const session of scopedSessions) {
    for (const checkpoint of session.checkpoints) {
      if (checkpoint.sessionId !== session.sessionId) continue;
      try {
        const before = turnSnapshotRef(session.sessionId, checkpoint.turnId, "before");
        const after = turnSnapshotRef(session.sessionId, checkpoint.turnId, "after");
        if (!refSet.has(before) || !refSet.has(after)) continue;
        if (!listedTreePair(objects, before, after)) await validateWorkspaceSnapshotRefs(cwd, before, after, {
          sessionId: session.sessionId,
          turnId: checkpoint.turnId,
        }, runGit);
        valid.add(before);
        valid.add(after);
      } catch {
        // Invalid entries are deliberately not roots for the GC sweep.
      }
    }
    for (const backup of session.backups ?? []) {
      if (backup.sessionId !== session.sessionId) continue;
      try {
        const before = turnSnapshotRef(session.sessionId, backup.turnId, "before");
        const after = turnSnapshotRef(session.sessionId, backup.turnId, "after");
        if (!refSet.has(before) || !refSet.has(after)) continue;
        if (!listedTreePair(objects, before, after)) await validateWorkspaceSnapshotRefs(cwd, before, after, {
          sessionId: session.sessionId,
          turnId: backup.turnId,
        }, runGit);
        valid.add(before);
        valid.add(after);
      } catch {
        // Invalid backup metadata is intentionally not a GC root.
      }
    }
    for (const transaction of session.restoreTransactions ?? []) {
      if (transaction.sessionId !== session.sessionId
        || transaction.state === "committed" || transaction.state === "recovered") continue;
      try {
        const before = turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, "before");
        const after = turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, "after");
        // Keep the rollback pair rooted for every pending state. A process can
        // die after publishing one phase, and deleting the surviving ref here
        // would make the durable recovery journal unrecoverable.
        if (refSet.has(before)) valid.add(before);
        if (refSet.has(after)) valid.add(after);
      } catch {
        // Parsed transaction refs are normally deterministic; malformed
        // objects supplied by legacy callers are not GC roots.
      }
    }
  }
  // Revalidate immediately before the destructive batch as well. The Git
  // ref scan and the linked-worktree lease namespace are separate resources;
  // an owner discovered here is never eligible for this sweep, even if its
  // refs appeared in the earlier enumeration.
  for (const sessionId of liveSessionIds(await listLiveWorkspaceLeaseSessions())) protectedSessionIds.add(sessionId);
  const doomed = refsForWorkspace.filter((ref) => !valid.has(ref) && !protectedSessionIds.has(ref.split("/")[3]));
  // A session the caller listed is one whose journal is meant to root these
  // refs. When it does not, the entry may simply not have landed yet, so age
  // decides. A session nobody listed was deleted offline; reclaim it at once.
  const recent = await recentSnapshotRefs(cwd, doomed.filter((ref) => knownSessionIds.has(ref.split("/")[3]!)), runGit, options);
  await Promise.all(doomed.filter((ref) => !recent.has(ref)).map((ref) =>
    runGit(cwd, ["update-ref", "-d", ref]).catch(() => undefined)));
  const checkpointRoot = join(FILESYSTEM_SNAPSHOT_ROOT, filesystemWorkspaceKey(canonicalCwd), "checkpoints");
  const filesystemRefs = await filesystemManifests(checkpointRoot);
  const validFilesystem = new Set<string>();
  // Without manifests nothing can be orphaned; a Git checkout keeps none.
  if (filesystemRefs.length > 0) for (const session of scopedSessions) {
    for (const checkpoint of session.checkpoints) {
      if (checkpoint.sessionId !== session.sessionId) continue;
      const before = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(session.sessionId, checkpoint.turnId, "before"));
      const after = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(session.sessionId, checkpoint.turnId, "after"));
      if (before && after) {
        validFilesystem.add(filesystemManifestPath(canonicalCwd, before.id));
        validFilesystem.add(filesystemManifestPath(canonicalCwd, after.id));
      }
    }
    for (const backup of session.backups ?? []) {
      if (backup.sessionId !== session.sessionId) continue;
      const before = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(session.sessionId, backup.turnId, "before"));
      const after = await readFilesystemSnapshot(canonicalCwd, turnSnapshotRef(session.sessionId, backup.turnId, "after"));
      if (before && after) {
        validFilesystem.add(filesystemManifestPath(canonicalCwd, before.id));
        validFilesystem.add(filesystemManifestPath(canonicalCwd, after.id));
      }
    }
    for (const transaction of session.restoreTransactions ?? []) {
      if (transaction.sessionId !== session.sessionId
        || transaction.state === "committed" || transaction.state === "recovered") continue;
      try {
        const before = filesystemManifestPath(canonicalCwd, turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, "before"));
        const after = filesystemManifestPath(canonicalCwd, turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, "after"));
        // Preserve each manifest independently. A partial pair still needs to
        // survive GC so startup can report the incomplete recovery honestly.
        if (filesystemRefs.includes(before)) validFilesystem.add(before);
        if (filesystemRefs.includes(after)) validFilesystem.add(after);
      } catch {
        // Parsed transaction refs are normally deterministic; malformed
        // objects supplied by legacy callers are not GC roots.
      }
    }
  }
  const protectedBeforeFilesystemGc = liveSessionIds(await listLiveWorkspaceLeaseSessions());
  const doomedManifests = filesystemRefs.filter((path) => !validFilesystem.has(path)
    && ![...protectedBeforeFilesystemGc].some((sessionId) => path.split(sep).includes(sessionId)));
  const recentManifestPaths = await recentManifests(
    doomedManifests.filter((path) => [...knownSessionIds].some((sessionId) => path.split(sep).includes(sessionId))),
    options,
  );
  await Promise.all(doomedManifests.filter((path) => !recentManifestPaths.has(path)).map((path) => rm(path, { force: true })));
  await gcFilesystemSnapshotBlobs(cwd);
}

function snapshotStatus(value: string): ChangeStatus {
  if (value.startsWith("A")) return "added";
  if (value.startsWith("D")) return "deleted";
  if (value.startsWith("R") || value.startsWith("C")) return "renamed";
  return "modified";
}

/** Parse `git diff --name-status -z` without interpreting file contents. */
function parseSnapshotNameStatus(stdout: string): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++] ?? "";
    if (!code) continue;
    const oldPath = tokens[index++] ?? "";
    const isRename = code.startsWith("R") || code.startsWith("C");
    const path = isRename ? (tokens[index++] ?? oldPath) : oldPath;
    if (path) statuses.set(path, snapshotStatus(code));
  }
  return statuses;
}

async function diffGitTrees(
  cwd: string,
  beforeTreeId: string,
  afterTreeId: string,
  branch: string | undefined,
  runGit: GitRunner,
): Promise<UiWorkspaceChanges> {
  const args = ["diff", "--no-ext-diff", "--find-renames", "--numstat", "-z", beforeTreeId, afterTreeId, "--"];
  const statusArgs = ["diff", "--no-ext-diff", "--find-renames", "--name-status", "-z", beforeTreeId, afterTreeId, "--"];
  const [numstat, nameStatus] = await Promise.all([
    runGit(cwd, args, SNAPSHOT_GIT_BUFFER),
    runGit(cwd, statusArgs, SNAPSHOT_GIT_BUFFER),
  ]);
  const counts = parseNumstat(numstat);
  const statuses = parseSnapshotNameStatus(nameStatus);
  const paths = new Set([...counts.keys(), ...statuses.keys()]);
  const files: UiChangedFile[] = [...paths].filter(Boolean).map((path) => {
    const counted = counts.get(path) ?? { added: 0, removed: 0 };
    return {
      path,
      ...describe(path),
      status: statuses.get(path) ?? "modified",
      added: counted.added,
      removed: counted.removed,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...(branch ? { branch } : {}),
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
    proposedMessage: proposeMessage(files),
  };
}

/**
 * Produces one checkpoint summary from the two immutable trees. It performs a
 * numstat and a name-status scan, but never opens a per-file patch; the latter
 * is reserved for `getSnapshotFileDiff` when a user explicitly opens a file.
 */
export async function diffWorkspaceSnapshots(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  options: SnapshotDiffOptions = {},
): Promise<UiWorkspaceChanges> {
  if (!isTurnSnapshotId(beforeSnapshotId) || !isTurnSnapshotId(afterSnapshotId)) {
    throw new Error("Invalid turn checkpoint snapshot ID.");
  }
  if (!snapshotPairShape(beforeSnapshotId, afterSnapshotId)) {
    throw new Error("Turn checkpoint snapshot refs must be an ordered before/after pair in one namespace.");
  }
  const runGit = options.runGit ?? git;
  const filesystem = await filesystemSnapshotPair(cwd, beforeSnapshotId, afterSnapshotId);
  if (filesystem) {
    if (options.expected) await validateWorkspaceSnapshotRefs(cwd, beforeSnapshotId, afterSnapshotId, options.expected, runGit);
    return diffFilesystemSnapshots(filesystem, options.branch);
  }
  if (options.expected) await validateWorkspaceSnapshotRefs(cwd, beforeSnapshotId, afterSnapshotId, options.expected, runGit);
  return diffGitTrees(cwd, beforeSnapshotId, afterSnapshotId, options.branch, runGit);
}

/**
 * Compares the live workspace with a verified checkpoint target. The result is
 * intentionally target-to-current (rather than current-to-HEAD): it describes
 * exactly which paths the restore will replace, add, or remove.
 */
export async function previewWorkspaceRestore(
  cwd: string,
  targetBeforeSnapshotId: string,
  targetAfterSnapshotId: string,
  expected: SnapshotRefExpectation,
  options: { branch?: string; runGit?: GitRunner } = {},
): Promise<UiWorkspaceChanges> {
  const runGit = options.runGit ?? git;
  const targetTrees = await validateRestorableWorkspaceSnapshotRefs(
    cwd,
    targetBeforeSnapshotId,
    targetAfterSnapshotId,
    expected,
    runGit,
  );
  const targetFilesystem = await filesystemSnapshotPair(cwd, targetBeforeSnapshotId, targetAfterSnapshotId);
  const previewTurnId = `restore-preview-${randomUUID()}`;
  const current = await createWorkspaceSnapshot(cwd, {
    namespace: `${sanitizeTurnSnapshotComponent(expected.sessionId)}/${sanitizeTurnSnapshotComponent(previewTurnId)}`,
    phase: "after",
  });
  try {
    if (targetFilesystem) {
      const currentFilesystem = await readFilesystemSnapshot(cwd, current.id);
      if (!currentFilesystem) throw new Error("The live workspace snapshot could not be verified.");
      return diffFilesystemSnapshots({ before: targetFilesystem.after, after: currentFilesystem }, options.branch);
    }
    if (current.backend !== "git") throw new Error("The checkpoint and live workspace use different snapshot backends.");
    return diffGitTrees(cwd, targetTrees.afterTreeId, current.treeId, options.branch, runGit);
  } finally {
    await deleteWorkspaceSnapshot(cwd, current.id, {
      sessionId: expected.sessionId,
      turnId: previewTurnId,
      phase: "after",
      treeId: current.treeId,
    }, runGit).catch(() => undefined);
  }
}

const MAX_SNAPSHOT_FILE_PAGE = 40;

function snapshotCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor)) throw new Error("Invalid turn file cursor.");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error("Invalid turn file cursor.");
  return offset;
}

/** Loads a bounded file-list page from Git; no complete list crosses the API seam. */
export async function diffWorkspaceSnapshotPage(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  options: SnapshotPageOptions,
): Promise<UiWorkspaceChangesPage> {
  const runGit = options.runGit ?? git;
  const full = await diffWorkspaceSnapshots(cwd, beforeSnapshotId, afterSnapshotId, {
    branch: options.branch,
    runGit,
    expected: { sessionId: options.sessionId, turnId: options.turnId },
  });
  const changes = options.attribute ? await options.attribute(full) : full;
  const offset = snapshotCursor(options.cursor, changes.files.length);
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : MAX_SNAPSHOT_FILE_PAGE;
  const limit = Math.min(MAX_SNAPSHOT_FILE_PAGE, Math.max(1, requestedLimit));
  const files = changes.files.slice(offset, offset + limit).map((file) => ({ ...file }));
  const nextCursor = offset + files.length < changes.files.length ? String(offset + files.length) : undefined;
  return {
    branch: changes.branch,
    files,
    fileCount: changes.files.length,
    ...(changes.completeness ? { completeness: changes.completeness } : {}),
    ...(changes.incompleteReason ? { incompleteReason: changes.incompleteReason } : {}),
    ...(changes.omittedFileCount !== undefined ? { omittedFileCount: changes.omittedFileCount } : {}),
    added: changes.added,
    removed: changes.removed,
    proposedMessage: changes.proposedMessage,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    hasMore: Boolean(nextCursor),
  };
}

/** One bounded scan supplies all project metadata consumers need. */
export async function readProjectGitState(
  cwd: string,
  options: ProjectScanOptions = {},
): Promise<ProjectGitState> {
  const runGit = options.runGit ?? git;
  const run = (args: string[], maxBuffer?: number): Promise<string> => {
    options.onGitCommand?.();
    return runGit(cwd, args, maxBuffer, options.signal);
  };
  try {
    const [rootOut, remoteOut, statusOut, numstatOut, worktreeOut, refOut] = await Promise.all([
      run(["rev-parse", "--show-toplevel"]),
      run(["remote"]).catch(() => ""),
      // Every untracked file, so a new folder lists its files rather than one row the review cannot open.
      run(["status", "--porcelain", "-z", "--untracked-files=all"]),
      run(["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
      run(["worktree", "list", "--porcelain"]),
      run(["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)", "--sort=-committerdate", "refs/heads"]),
    ]);
    const workspaceRoot = rootOut.trim() || cwd;
    const worktrees = parseWorktrees(worktreeOut, workspaceRoot);
    const branch = worktrees.find((tree) => tree.isCurrent)?.branch;
    const statuses = parseStatus(statusOut);
    const counts = parseNumstat(numstatOut);
    const files: UiChangedFile[] = [];
    // A new build folder can hold thousands of files; line counts stop after the first few hundred.
    const untracked = [...statuses].filter(([, value]) => value.status === "untracked").slice(0, UNTRACKED_STAT_LIMIT);
    const stats = new Map<string, number>();
    const limit = 4;
    for (let index = 0; index < untracked.length; index += limit) {
      await Promise.all(untracked.slice(index, index + limit).map(async ([path]) => {
        stats.set(path, await countUntrackedLines(cwd, path, options.untrackedStats));
      }));
    }
    for (const [path, value] of statuses) {
      const { status, staged } = value;
      const counted = counts.get(path);
      const added = counted?.added ?? (status === "untracked" ? stats.get(path) ?? 0 : 0);
      files.push({ path, ...describe(path), status, added, removed: counted?.removed ?? 0, staged });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const changes: UiWorkspaceChanges = {
      branch,
      files,
      added: files.reduce((total, file) => total + file.added, 0),
      removed: files.reduce((total, file) => total + file.removed, 0),
      proposedMessage: proposeMessage(files),
    };

    const heldByWorktree = new Map(
      worktrees.filter((tree) => tree.branch && tree.branch !== "detached").map((tree) => [tree.branch as string, tree.path]),
    );
    const refMetadata = refOut.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, upstream, tracking = "", committedAt = ""] = line.split("\t");
      const commitSeconds = Number(committedAt);
      return {
        name,
        upstream: upstream || undefined,
        ahead: Number(/ahead (\d+)/u.exec(tracking)?.[1] ?? 0),
        behind: Number(/behind (\d+)/u.exec(tracking)?.[1] ?? 0),
        lastCommitAt: Number.isFinite(commitSeconds) && commitSeconds > 0 ? commitSeconds * 1_000 : undefined,
      };
    });
    const refs: UiRef[] = refMetadata.map((metadata) => ({
      ...metadata,
      isCurrent: metadata.name === branch,
      worktreePath: heldByWorktree.get(metadata.name),
    }));
    const currentRef = refMetadata.find((ref) => ref.name === branch);
    const mainRoot = worktrees.find((tree) => tree.isMain)?.path ?? workspaceRoot;
    const configuredParent = options.worktreeParent ?? await readWorktreeConfig(mainRoot, workspaceRoot);
    const worktreeParent = resolveWorktreeParent(mainRoot, configuredParent);
    const workspace: WorkspaceInfo = {
      root: workspaceRoot,
      isRepo: true,
      isDirty: statusOut.trim().length > 0,
      branch,
      upstream: currentRef?.upstream,
      ahead: currentRef?.ahead,
      behind: currentRef?.behind,
      hasRemote: remoteOut.trim().length > 0,
      worktrees,
      refs,
      worktreeParent,
    };
    return { changes, workspace, branch };
  } catch (error) {
    if (options.throwOnError) throw error;
    return emptyProjectGitState(cwd);
  }
}

export function parseUnifiedDiff(path: string, patch: string, options: DiffLoadOptions = {}, sourceTruncated = false): UiFileDiff {
  const hunks: UiDiffHunk[] = [];
  let current: UiDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  const patchBytes = Buffer.from(patch, "utf8");
  const byteTruncated = sourceTruncated || patchBytes.length > MAX_DIFF_BYTES;
  const bytePrefix = byteTruncated ? patchBytes.subarray(0, MAX_DIFF_BYTES).toString("utf8") : patch;
  const boundedPatch = byteTruncated ? bytePrefix.slice(0, bytePrefix.lastIndexOf("\n") + 1) : bytePrefix;
  const rawLines = boundedPatch.split("\n");
  const lineTruncated = rawLines.length > MAX_DIFF_LINES;
  const boundedLines = rawLines.slice(0, MAX_DIFF_LINES);
  for (const raw of boundedLines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw.slice(0, raw.indexOf("@@", 2) + 2) + header[3], lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    // "" is the artifact of the patch's trailing newline; a blank context line is " ".
    if (raw === "" || raw.startsWith("\\")) continue;

    let line: UiDiffLine;
    if (raw.startsWith("+")) {
      line = { kind: "added", newLine: newLine++, text: raw.slice(1) };
      added += 1;
    } else if (raw.startsWith("-")) {
      line = { kind: "removed", oldLine: oldLine++, text: raw.slice(1) };
      removed += 1;
    } else {
      line = { kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) };
    }
    current.lines.push(line);
  }

  const { hunkOffset: offset, hunkLimit: limit } = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS);
  const visibleHunks = hunks.slice(offset, offset + limit);
  const hasMoreParsedHunks = hunks.length > offset + visibleHunks.length;
  const truncated = byteTruncated || lineTruncated || hasMoreParsedHunks;
  return {
    path,
    added,
    removed,
    hunks: visibleHunks,
    truncated,
    nextHunkOffset: hasMoreParsedHunks ? offset + visibleHunks.length : undefined,
    note: hasMoreParsedHunks
      ? `Showing ${visibleHunks.length} hunks. Load more to continue.`
      : byteTruncated || lineTruncated
        ? "Diff truncated at the host byte or line limit. Open the file in an editor for the complete patch."
        : undefined,
  };
}

interface StreamedPatch {
  patch: string;
  capturedHunks: number;
  hasMoreHunks: boolean;
  terminalTruncation: boolean;
}

/**
 * Reads only the requested hunk window from git's stdout. Earlier hunks are
 * scanned but never retained, and the child is stopped as soon as the next
 * page or a terminal byte/line ceiling is known.
 */
async function streamFilePatch(
  cwd: string,
  args: string[],
  options: DiffLoadOptions,
  allowNoIndexDifference = false,
): Promise<StreamedPatch> {
  const { hunkOffset: offset, hunkLimit: limit } = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS);
  return new Promise((settle, reject) => {
    const child = spawn(gitExecutable(), ["-c", "core.quotePath=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let pending = "";
    let stderr = "";
    let header = "";
    let selected = "";
    let hunkIndex = -1;
    let capturedHunks = 0;
    let selectedLines = 0;
    let selectedBytes = 0;
    let hasMoreHunks = false;
    let terminalTruncation = false;
    let stopped = false;
    let discardingLine = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
    };
    const appendSelected = (line: string) => {
      const bytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (selectedLines >= MAX_DIFF_LINES || selectedBytes + bytes > MAX_DIFF_BYTES) {
        terminalTruncation = true;
        stop();
        return;
      }
      selected += `${line}\n`;
      selectedLines += 1;
      selectedBytes += bytes;
    };
    const consumeLine = (line: string) => {
      if (line.startsWith("@@")) {
        hunkIndex += 1;
        if (hunkIndex >= offset + limit) {
          hasMoreHunks = true;
          stop();
          return;
        }
        if (hunkIndex >= offset) capturedHunks += 1;
      }
      if (hunkIndex < 0) {
        if (Buffer.byteLength(header, "utf8") < 64 * 1024) header += `${line}\n`;
      } else if (hunkIndex >= offset) {
        appendSelected(line);
      }
    };
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (discardingLine) {
        const newline = pending.indexOf("\n");
        if (newline < 0) { pending = ""; return; }
        pending = pending.slice(newline + 1);
        discardingLine = false;
      }
      let newline = pending.indexOf("\n");
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- stopped is set by stop(), called from consumeLine below; the linter can't trace that call chain.
      while (!stopped && newline >= 0) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (stopped) return;
      const pendingBytes = Buffer.byteLength(pending, "utf8");
      if (hunkIndex >= 0 && hunkIndex < offset && pendingBytes > 64 * 1024) {
        pending = "";
        discardingLine = true;
      } else if (hunkIndex >= offset && selectedBytes + pendingBytes > MAX_DIFF_BYTES) {
        pending = "";
        terminalTruncation = true;
        stop();
      } else if (hunkIndex < 0 && pendingBytes > 64 * 1024) {
        pending = "";
        terminalTruncation = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    const timeout = setTimeout(() => {
      terminalTruncation = true;
      stop();
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!stopped && pending) consumeLine(pending);
      if (!stopped && code !== 0 && !(allowNoIndexDifference && code === 1)) {
        reject(new Error(stderr.trim() || `git diff exited with ${code}`));
        return;
      }
      settle({ patch: header + selected, capturedHunks, hasMoreHunks, terminalTruncation });
    });
  });
}

export async function getFileDiff(cwd: string, path: string, options: DiffLoadOptions = {}): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  try {
    const branchBase = options.scope === "branch"
      ? options.baseCommit ? { ref: options.baseRef ?? options.baseCommit, mergeBase: options.baseCommit } : await resolveBranchBase(cwd, options.baseRef)
      : undefined;
    const view = diffViewArguments(options);
    let streamed = await streamFilePatch(cwd, ["diff", "--no-ext-diff", ...view, branchBase?.mergeBase ?? "HEAD", ...(branchBase ? ["HEAD"] : []), "--", path], options);
    if (!streamed.patch.trim()) {
      const whitespaceOnly = options.ignoreWhitespace === true
        && (Boolean(branchBase) || await git(cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true, () => false));
      if (whitespaceOnly) return empty("Only whitespace changed.");
      if (branchBase) return empty("No textual changes.");
      // Untracked files have no HEAD side; diff them against an empty tree.
      streamed = await streamFilePatch(cwd, ["diff", "--no-ext-diff", ...view, "--no-index", "--", "/dev/null", path], options, true);
    }
    if (!streamed.patch.trim()) return empty("No textual changes.");
    if (/^Binary files /mu.test(streamed.patch)) return empty("Binary file — no line diff.");
    const result = parseUnifiedDiff(path, streamed.patch, { hunkLimit: MAX_DIFF_HUNKS }, streamed.terminalTruncation);
    if (streamed.hasMoreHunks) {
      const offset = Math.max(0, options.hunkOffset ?? 0);
      return {
        ...result,
        truncated: true,
        nextHunkOffset: offset + streamed.capturedHunks,
        note: `Showing ${streamed.capturedHunks} hunks. Load more to continue.`,
      };
    }
    return result;
  } catch {
    return empty("Could not read this diff.");
  }
}

async function resolveBranchBase(cwd: string, requested?: string, runGit: GitRunner = git): Promise<{ ref: string; mergeBase: string }> {
  const remoteDefault = requested ? "" : (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  const upstream = requested ? "" : (await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
  // A worktree Tau created recorded the base it started from; it beats guessing.
  const branch = requested ? "" : (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
  const recorded = branch ? await readBranchBase(cwd, branch, runGit) : undefined;
  const candidates = requested
    ? [requested]
    : [
        recorded ?? "",
        remoteDefault,
        "origin/main",
        "main",
        "origin/master",
        "master",
        "origin/develop",
        "develop",
        upstream,
      ].filter(Boolean);
  for (const candidate of candidates) {
    const exists = await runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate]).then(() => true).catch(() => false);
    if (!exists) continue;
    const mergeBase = (await runGit(cwd, ["merge-base", candidate, "HEAD"]).catch(() => "")).trim();
    if (mergeBase) return { ref: candidate, mergeBase };
  }
  throw new Error("No branch comparison base is available.");
}

/** The first candidate that names a commit in this checkout, e.g. `origin/main` before `main`. */
export async function firstExistingRef(cwd: string, candidates: string[], runGit: GitRunner = git): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate]).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

export async function getBranchChanges(
  cwd: string,
  query: WorkspaceChangesQuery = {},
  runGit: GitRunner = git,
): Promise<UiWorkspaceChanges> {
  const branch = (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim() || undefined;
  const base = await resolveBranchBase(cwd, query.baseRef, runGit);
  const changes = await diffGitTrees(cwd, base.mergeBase, "HEAD", branch, runGit);
  return { ...changes, scope: "branch", baseRef: base.ref, baseCommit: base.mergeBase };
}

export async function stageFile(cwd: string, path: string, runGit: GitRunner = git): Promise<void> {
  await assertWorkspacePath(cwd, path);
  await runGit(cwd, ["add", "--", path]);
}

export async function unstageFile(cwd: string, path: string, runGit: GitRunner = git): Promise<void> {
  await assertWorkspacePath(cwd, path);
  await runGit(cwd, ["restore", "--staged", "--", path]);
}

export async function stageAll(cwd: string, runGit: GitRunner = git): Promise<void> {
  await runGit(cwd, ["add", "-A"]);
}

export async function revertFile(cwd: string, path: string, runGit: GitRunner = git): Promise<void> {
  await assertWorkspacePath(cwd, path);
  const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true).catch(() => false);
  if (tracked) {
    await runGit(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);
  } else {
    await runGit(cwd, ["clean", "-fd", "--", path]);
  }
}

/**
 * Loads one file's historical patch directly from the immutable before/after
 * snapshots. No checkpoint entry contains patch bytes, and this call performs
 * one `git diff <before> <after> -- <path>` on demand.
 */
export async function getSnapshotFileDiff(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  path: string,
  options: DiffLoadOptions = {},
  expected?: SnapshotRefExpectation,
): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  if (!isTurnSnapshotId(beforeSnapshotId) || !isTurnSnapshotId(afterSnapshotId)) {
    return empty("This turn checkpoint is no longer available.");
  }
  if (!snapshotPairShape(beforeSnapshotId, afterSnapshotId)) {
    return empty("This turn checkpoint is no longer available.");
  }
  try {
    await assertWorkspacePath(cwd, path);
    const filesystem = await filesystemSnapshotPair(cwd, beforeSnapshotId, afterSnapshotId);
    if (filesystem) {
      const beforeFile = filesystem.before.files[path];
      const afterFile = filesystem.after.files[path];
      if (beforeFile?.hash === afterFile?.hash) {
        return empty(beforeFile?.mode === afterFile?.mode ? "No textual changes." : "File mode changed; no textual changes.");
      }
      const unavailableReason = afterFile?.unavailableReason ?? beforeFile?.unavailableReason;
      if (beforeFile?.contentAvailable === false || afterFile?.contentAvailable === false) {
        return empty(unavailableReason ?? "Historical content was not stored for this file.");
      }
      const [beforeBytes, afterBytes] = await Promise.all([
        beforeFile ? readFile(filesystemBlobPath(filesystem.before.cwd, beforeFile.hash)) : Promise.resolve(Buffer.alloc(0)),
        afterFile ? readFile(filesystemBlobPath(filesystem.after.cwd, afterFile.hash)) : Promise.resolve(Buffer.alloc(0)),
      ]);
      if (beforeBytes.includes(0) || afterBytes.includes(0)) return empty("Binary file — no line diff.");
      const beforeText = beforeBytes.toString("utf8");
      const afterText = afterBytes.toString("utf8");
      const beforeLines = beforeText ? beforeText.split("\n") : [];
      const afterLines = afterText ? afterText.split("\n") : [];
      if (beforeLines.at(-1) === "") beforeLines.pop();
      if (afterLines.at(-1) === "") afterLines.pop();
      const patch = [
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -${beforeLines.length ? 1 : 0},${beforeLines.length} +${afterLines.length ? 1 : 0},${afterLines.length} @@`,
        ...beforeLines.map((line) => `-${line}`),
        ...afterLines.map((line) => `+${line}`),
        "",
      ].join("\n");
      return parseUnifiedDiff(path, patch, options);
    }
    if (expected) await validateWorkspaceSnapshotRefs(cwd, beforeSnapshotId, afterSnapshotId, expected);
    const streamed = await streamFilePatch(
      cwd,
      ["diff", "--no-ext-diff", "--find-renames", ...diffViewArguments(options), beforeSnapshotId, afterSnapshotId, "--", path],
      options,
    );
    if (!streamed.patch.trim()) return empty("No textual changes.");
    if (/^Binary files /mu.test(streamed.patch)) return empty("Binary file — no line diff.");
    const result = parseUnifiedDiff(path, streamed.patch, {}, streamed.terminalTruncation);
    if (streamed.hasMoreHunks) {
      const offset = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS).hunkOffset;
      return {
        ...result,
        truncated: true,
        nextHunkOffset: offset + streamed.capturedHunks,
        note: `Showing ${streamed.capturedHunks} hunks. Load more to continue.`,
      };
    }
    return result;
  } catch {
    return empty("Could not read this historical diff.");
  }
}

export async function commit(
  cwd: string,
  message: string,
  shouldPush: boolean,
  readChanges: (cwd: string) => Promise<UiWorkspaceChanges> = async (path) => (await readProjectGitState(path)).changes,
): Promise<CommitResult> {
  const subject = message.trim();
  if (!subject) throw new Error("A commit message is required.");
  const staged = (await git(cwd, ["diff", "--cached", "--name-only"])).trim();
  if (!staged) await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", subject]);
  const committed = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  let pushed = false;
  let detail = `Committed ${committed}`;
  if (shouldPush) {
    await pushCurrentBranch(cwd);
    pushed = true;
    detail = `Committed ${committed} and pushed`;
  }
  return { changes: await readChanges(cwd), pushed, detail };
}

export async function pull(cwd: string, runGit: GitRunner = git): Promise<PullResult> {
  await runGit(cwd, ["pull", "--ff-only"], 8 * 1024 * 1024);
  const committed = (await runGit(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return { detail: `Pulled ${committed}` };
}

/**
 * Pushes the checked-out branch. A branch without an upstream is published to
 * `origin` (or the only remote) and starts tracking it, which is what a new
 * pull request needs; a repository without a remote says so.
 */
export async function pushCurrentBranch(cwd: string, runGit: GitRunner = git): Promise<void> {
  const upstream = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")).trim();
  if (upstream) {
    await runGit(cwd, ["push"], 8 * 1024 * 1024);
    return;
  }
  const branch = (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
  if (!branch) throw new Error("Check out a branch before pushing; HEAD is detached.");
  const remote = await primaryRemote(cwd, runGit);
  if (!remote) throw new Error("This repository has no remote to push to. Add one with `git remote add origin <url>`.");
  await runGit(cwd, ["push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`], 8 * 1024 * 1024);
}

/** `origin` when it exists, else the only remote; undefined without one. */
export async function primaryRemote(cwd: string, runGit: GitRunner = git): Promise<string | undefined> {
  const remotes = (await runGit(cwd, ["remote"]).catch(() => "")).split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes[0];
}

/**
 * The first remote of a repository that has none, for a repository just
 * published. It never replaces or adds beside an existing remote; whether
 * there is a commit to push afterwards is the answer.
 */
export async function addFirstRemote(cwd: string, name: string, url: string, runGit: GitRunner = git): Promise<{ hasCommits: boolean }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error(`"${name}" is not a remote name.`);
  if (!url || url.startsWith("-") || /[\s\0]/u.test(url)) throw new Error("That is not a remote URL.");
  const remotes = (await runGit(cwd, ["remote"])).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  if (remotes.length > 0) throw new Error(`This repository already has a remote (${remotes.join(", ")}).`);
  await runGit(cwd, ["remote", "add", name, url]);
  const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "");
  return { hasCommits: head.trim().length > 0 };
}

export async function push(cwd: string, runGit: GitRunner = git): Promise<PushResult> {
  await pushCurrentBranch(cwd, runGit);
  const committed = (await runGit(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return { detail: `Pushed ${committed}` };
}

export async function listTerminals(): Promise<UiTerminal[]> {
  if (process.platform === "darwin") {
    const apps: Record<string, string> = {
      ghostty: "/Applications/Ghostty.app",
      iterm: "/Applications/iTerm.app",
      warp: "/Applications/Warp.app",
      kitty: "/Applications/kitty.app",
      alacritty: "/Applications/Alacritty.app",
      terminal: "/System/Applications/Utilities/Terminal.app",
    };
    return KNOWN_TERMINALS.filter((term) => findExecutable(term.id) !== undefined || (apps[term.id] && existsSync(apps[term.id])));
  }
  return KNOWN_TERMINALS.filter((term) => findExecutable(term.id) !== undefined);
}

export async function openTerminal(cwd: string, terminalId?: string): Promise<void> {
  const available = await listTerminals();
  const chosen = terminalId ? KNOWN_TERMINALS.find((t) => t.id === terminalId) : available[0];
  const target = chosen?.id ?? (process.platform === "darwin" ? "terminal" : "xterm");

  if (process.platform === "darwin") {
    const appNames: Record<string, string> = {
      ghostty: "Ghostty",
      iterm: "iTerm",
      warp: "Warp",
      kitty: "kitty",
      alacritty: "Alacritty",
      terminal: "Terminal",
    };
    const appName = appNames[target] ?? "Terminal";
    await execFileAsync("open", ["-a", appName, cwd], { cwd });
  } else if (process.platform === "win32") {
    await execFileAsync("wt.exe", ["-d", cwd], { cwd }).catch(() =>
      execFileAsync("cmd.exe", ["/c", "start"], { cwd })
    );
  } else {
    await execFileAsync(target, [], { cwd });
  }
}

/** Where added worktrees live: beside the repository by default, or configured location. */
export function worktreeParentFor(mainRoot: string, configured?: string): string {
  return resolveWorktreeParent(mainRoot, configured);
}

export function worktreeSlug(branch: string): string {
  return branch.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "worktree";
}

export const WORKTREE_CLEANUP_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/** Cleanup stays a suggestion and fails closed when any safety fact is missing. */
export function isWorktreeCleanupCandidate(
  tree: UiWorktree,
  status: Omit<UiWorktreeStatus, "path" | "cleanupCandidate">,
  now = Date.now(),
): boolean {
  return !tree.isMain
    && !tree.isCurrent
    && status.isDirty === false
    && status.threadCount === 0
    && Boolean(status.upstream)
    && status.ahead === 0
    && status.lastCommitAt !== undefined
    && now - status.lastCommitAt >= WORKTREE_CLEANUP_MIN_AGE_MS
    && !status.inspectionError;
}

/**
 * Reads dirty state only on demand. Normal project refreshes remain one bounded
 * scan even when a repository has many linked worktrees.
 */
export async function readWorktreeStatuses(
  worktrees: readonly UiWorktree[],
  refs: readonly UiRef[],
  threadCwds: readonly string[],
  runGit: GitRunner = git,
  now = Date.now(),
): Promise<UiWorktreeStatus[]> {
  // The picker is the one place worth pruning: a worktree whose folder went
  // away is a row the user is about to act on.
  const main = worktrees.find((tree) => tree.isMain) ?? worktrees[0];
  if (main) await runGit(main.path, ["worktree", "prune"]).catch(() => "");
  return Promise.all(worktrees.map(async (tree) => {
    const ref = refs.find((candidate) => candidate.name === tree.branch);
    const base = {
      upstream: ref?.upstream,
      ahead: ref?.ahead ?? 0,
      behind: ref?.behind ?? 0,
      threadCount: threadCwds.filter((path) => resolve(path) === resolve(tree.path)).length,
      lastCommitAt: ref?.lastCommitAt,
    };
    try {
      const status: Omit<UiWorktreeStatus, "path" | "cleanupCandidate"> = {
        ...base,
        isDirty: (await runGit(tree.path, ["status", "--porcelain", "-z"])).length > 0,
      };
      return { path: tree.path, ...status, cleanupCandidate: isWorktreeCleanupCandidate(tree, status, now) };
    } catch (error) {
      return {
        path: tree.path,
        ...base,
        ahead: base.ahead,
        behind: base.behind,
        cleanupCandidate: false,
        inspectionError: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

/**
 * `git worktree list --porcelain` emits blank-line separated records; the first
 * record is always the repository's primary checkout.
 */
function parseWorktrees(stdout: string, cwd: string): UiWorktree[] {
  const worktrees: UiWorktree[] = [];
  for (const block of stdout.split("\n\n")) {
    const path = /^worktree (.+)$/mu.exec(block)?.[1];
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1] ?? (/^detached$/mu.test(block) ? "detached" : undefined);
    worktrees.push({
      path,
      name: basename(path),
      branch,
      isMain: worktrees.length === 0,
      isCurrent: path === cwd,
    });
  }
  return worktrees;
}

/** Defers to git's own rules rather than guessing at them. */
async function assertValidBranchName(cwd: string, name: string, runGit: GitRunner = git): Promise<void> {
  const invalid = new Error(`"${name}" is not a valid branch name.`);
  if (name.startsWith("-") || /[\s~^:?*[\\]/u.test(name)) throw invalid;
  try {
    await runGit(cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw invalid;
  }
}

/**
 * The branch a new worktree starts from when nobody named one: what
 * `origin/HEAD` points at, then the usual main lines, then this checkout's own
 * branch. A repository without any of them still answers, with `HEAD`.
 */
export async function resolveDefaultBaseRef(cwd: string, runGit: GitRunner = git): Promise<string> {
  const originHead = (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (originHead) return originHead;
  const known = await firstExistingRef(cwd, ["origin/main", "origin/master", "main", "master"], runGit);
  if (known) return known;
  const branch = (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
  return branch || "HEAD";
}

/**
 * The branch a project calls its main line, by name: the one `origin/HEAD`
 * points at, else `init.defaultBranch`, else `main`.
 */
export async function readDefaultBranch(cwd: string, runGit: GitRunner = git): Promise<string> {
  const originHead = (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (originHead) return originHead.replace(/^origin\//u, "");
  const configured = (await runGit(cwd, ["config", "--get", "init.defaultBranch"]).catch(() => "")).trim();
  return configured || "main";
}

/** Where a new worktree starts: the ref the user sees, and the commit it resolved to. */
export interface WorktreeBase {
  /** `origin/main`, `main`, a tag — whatever names the base for a human. */
  ref: string;
  /** The commit the worktree is created at; empty in a repository without commits. */
  commit: string;
  /** The commit came from a freshly fetched remote-tracking ref. */
  fromOrigin: boolean;
  /** Why the resolved base is not the one that was asked for. */
  note?: string;
}

const REMOTE_PREFIX = /^([^/]+)\//u;

/**
 * Resolves the base of a new worktree: with "start from
 * origin" the remote is fetched and the worktree is created at that SHA, so a
 * stale local branch never becomes the starting point. A repository without the
 * remote branch falls back to the local base rather than failing.
 */
export async function resolveWorktreeBase(
  cwd: string,
  options: { requested?: string; startFromOrigin?: boolean } = {},
  runGit: GitRunner = git,
): Promise<WorktreeBase> {
  const requested = options.requested?.trim();
  const base = requested || await resolveDefaultBaseRef(cwd, runGit);
  const remotes = (await runGit(cwd, ["remote"]).catch(() => ""))
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  const named = REMOTE_PREFIX.exec(base)?.[1];
  const remote = named && remotes.includes(named) ? named : undefined;
  // Only a base that names a remote is fetched unasked; "start from origin"
  // additionally looks for the local base's remote-tracking ref.
  const tracking = !remote && options.startFromOrigin !== false && remotes.includes("origin")
    ? `origin/${base}`
    : undefined;
  // A base the caller named is fetched or the creation fails; the remote a
  // default base is only *hoped* to have must not break a picker that is
  // offline, so its fetch failure degrades to the local base.
  if (remote) await runGit(cwd, ["fetch", "--prune", remote], 8 * 1024 * 1024);
  let fetchError: string | undefined;
  if (tracking) {
    fetchError = await runGit(cwd, ["fetch", "--prune", "origin"], 8 * 1024 * 1024)
      .then(() => undefined)
      .catch((error: unknown) => error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
  const commitOf = async (ref: string) => (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "")).trim();
  if (tracking && !fetchError) {
    const remoteCommit = await commitOf(tracking);
    if (remoteCommit) return { ref: tracking, commit: remoteCommit, fromOrigin: true };
  }
  const resolved = await commitOf(base);
  if (!resolved) throw new Error(`The worktree base "${base}" does not exist.`);
  return {
    ref: base,
    commit: resolved,
    fromOrigin: Boolean(remote),
    ...(tracking ? { note: fetchError ? `origin is unreachable (${fetchError}); started from ${base}.` : `${tracking} does not exist; started from ${base}.` } : {}),
  };
}

/** What "Based on" lists beside `base`: when the remote was last fetched, and origin's other latest branches. */
export async function readBaseChoices(cwd: string, base: string, runGit: GitRunner = git): Promise<{ fetchedAt?: number; others: string[] }> {
  const [fetchedAt, listed] = await Promise.all([
    runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])
      .then((path) => stat(path.trim()))
      .then((info) => info.mtimeMs, () => undefined),
    runGit(cwd, ["for-each-ref", "--sort=-committerdate", "--count=12", "--format=%(refname:short)", "refs/remotes/origin"]).catch(() => ""),
  ]);
  // `origin/HEAD` reads as plain `origin` in its short form.
  const others = listed.split("\n").map((ref) => ref.trim()).filter((ref) => ref.includes("/") && ref !== base && ref !== "origin/HEAD").slice(0, 8);
  return { ...(fetchedAt ? { fetchedAt } : {}), others };
}

/**
 * The base a branch was created from, kept in the repository's own config so a
 * later diff, review or pull request has the same answer this worktree started
 * with. `getBranchChanges` resolves a base of its own when nothing is recorded.
 * The key itself lives in `agent-worktrees.ts`, the leaf both sides share.
 */
export {
  branchBaseConfigKey,
  readBranchBase,
  readWorktreeConfig,
  resolveWorktreeParent,
  worktreeParentOf,
} from "./agent-worktrees.js";

/**
 * Whether `cwd` is a linked worktree rather than a repository's main checkout.
 * A linked worktree's own git dir sits under the shared common dir; anything
 * that is not a repository at all is not a worktree.
 */
export async function isLinkedWorktree(cwd: string, runGit: GitRunner = git): Promise<boolean> {
  const [gitDir, commonDir] = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]))
    .split("\n")
    .map((line) => line.trim());
  if (!gitDir || !commonDir) throw new Error(`${cwd} is not a Git repository.`);
  return resolve(cwd, gitDir) !== resolve(cwd, commonDir);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The project list also withholds remembered worktrees after their folders have been removed. */
export async function isNestedProject(
  cwd: string,
  runGit: GitRunner = git,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<boolean> {
  return !await exists(cwd) || isLinkedWorktree(cwd, runGit);
}

/** Returns one stable project name for a repository and all of its linked worktrees. */
export async function repositoryDisplayName(cwd: string, runGit: GitRunner = git): Promise<string> {
  try {
    const commonDir = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const absoluteCommonDir = resolve(cwd, commonDir);
    return basename(dirname(absoluteCommonDir)) || basename(cwd) || cwd;
  } catch {
    return basename(cwd) || cwd;
  }
}

export interface CreateWorktreeOptions {
  /** The base the user picked; the repository's default branch when absent. */
  baseRef?: string;
  /** Fetch and start from the remote-tracking commit; on by default. */
  startFromOrigin?: boolean;
  /** Told when a step begins, for a setup card that follows it. */
  onStep?(step: "fetch" | "checkout"): void;
}

/** Creates a branch and a worktree for it, and returns the new worktree path. */
export async function createWorktree(
  cwd: string,
  branch: string,
  options: CreateWorktreeOptions = {},
  readWorkspace: (cwd: string) => Promise<WorkspaceInfo> = async (path) => (await readProjectGitState(path)).workspace,
  runGit: GitRunner = git,
): Promise<string> {
  const name = branch.trim();
  if (!name) throw new Error("A branch name is required.");
  await assertValidBranchName(cwd, name, runGit);
  const info = await readWorkspace(cwd);
  if (!info.isRepo) throw new Error("This workspace is not a Git repository.");

  const existing = info.refs.find((ref) => ref.name === name);
  if (existing?.worktreePath) throw new Error(`${name} is already checked out in a worktree.`);

  const destination = join(info.worktreeParent, worktreeSlug(name));
  await mkdir(info.worktreeParent, { recursive: true });
  if (existing) {
    options.onStep?.("checkout");
    await runGit(cwd, ["worktree", "add", destination, name]);
    return destination;
  }
  options.onStep?.("fetch");
  const base = await resolveWorktreeBase(cwd, {
    ...(options.baseRef || info.branch ? { requested: options.baseRef || info.branch } : {}),
    ...(options.startFromOrigin === undefined ? {} : { startFromOrigin: options.startFromOrigin }),
  }, runGit);
  // The commit, not the ref: a worktree started at `origin/main` would follow
  // that ref's next move, and the base recorded below would stop describing it.
  options.onStep?.("checkout");
  await runGit(cwd, ["worktree", "add", "-b", name, destination, base.commit || base.ref]);
  await runGit(cwd, ["config", branchBaseConfigKey(name), base.ref]).catch(() => "");
  return destination;
}

/** Uncommitted work in a worktree, as the removal confirm names it. */
export interface WorktreeRemovalPreview {
  path: string;
  branch?: string;
  dirtyFiles: number;
  /** Commits the branch carries beyond the base it started from. */
  ahead: number;
}

export async function previewWorktreeRemoval(
  cwd: string,
  worktreePath: string,
  branch: string | undefined,
  runGit: GitRunner = git,
): Promise<WorktreeRemovalPreview> {
  const status = await runGit(worktreePath, ["status", "--porcelain", "-z"]).catch(() => "");
  const dirtyFiles = status.split("\0").filter((line) => line.trim().length > 0).length;
  const base = branch ? await readBranchBase(worktreePath, branch, runGit) : undefined;
  const revList = base ? await runGit(worktreePath, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "") : "";
  return { path: worktreePath, ...(branch ? { branch } : {}), dirtyFiles, ahead: Number(revList.trim()) || 0 };
}

/**
 * Removes a linked worktree and, when asked, the branch it held. `--force`
 * because the caller already showed what would be lost; git's own refusal to
 * remove a dirty worktree would only turn that decision into an error.
 */
export async function removeWorktree(
  cwd: string,
  worktreePath: string,
  options: { branch?: string } = {},
  runGit: GitRunner = git,
): Promise<void> {
  await runGit(cwd, ["worktree", "remove", "--force", worktreePath]).catch(async (error: unknown) => {
    // A worktree whose directory is already gone is removed by pruning it.
    await runGit(cwd, ["worktree", "prune"]);
    const still = await runGit(cwd, ["worktree", "list", "--porcelain"]).catch(() => "");
    if (still.includes(`worktree ${worktreePath}\n`)) throw error;
  });
  if (options.branch) await runGit(cwd, ["branch", "-D", options.branch]).catch(() => "");
}

/**
 * The worktree a thread expects, recreated silently when its directory
 * vanished: a missing folder is an accident, not a decision.
 */
export async function ensureWorktree(
  cwd: string,
  worktreePath: string,
  branch: string | undefined,
  runGit: GitRunner = git,
): Promise<boolean> {
  if (await stat(worktreePath).then((entry) => entry.isDirectory()).catch(() => false)) return false;
  if (!branch) throw new Error(`${worktreePath} is gone and no branch names what it held.`);
  await runGit(cwd, ["worktree", "prune"]);
  await mkdir(dirname(worktreePath), { recursive: true });
  await runGit(cwd, ["worktree", "add", worktreePath, branch]);
  return true;
}

/**
 * Resolves a ref to a workspace path. A ref already held by a worktree is opened
 * there; otherwise it is checked out in place, which requires a clean tree.
 */
/** A new branch at HEAD, checked out in place; uncommitted work comes along. */
export async function createBranch(cwd: string, branch: string, runGit: GitRunner = git): Promise<void> {
  const name = branch.trim();
  if (!name) throw new Error("A branch name is required.");
  await assertValidBranchName(cwd, name, runGit);
  await runGit(cwd, ["switch", "-c", name]);
}

export async function resolveRefTarget(
  cwd: string,
  ref: string,
  readWorkspace: (cwd: string) => Promise<WorkspaceInfo> = async (path) => (await readProjectGitState(path)).workspace,
): Promise<string> {
  const info = await readWorkspace(cwd);
  if (!info.isRepo) throw new Error("This workspace is not a Git repository.");

  const target = info.refs.find((entry) => entry.name === ref);
  if (target?.worktreePath) return target.worktreePath;
  if (info.isDirty) {
    throw new Error(
      `${cwd} has uncommitted changes. Commit them, or create a worktree for ${ref} instead.`,
    );
  }
  await git(cwd, ["switch", ref]);
  return info.root;
}
