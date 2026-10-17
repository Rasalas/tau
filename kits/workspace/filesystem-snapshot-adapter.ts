import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ChangeStatus, DiffLoadOptions, UiChangedFile, UiFileDiff, UiWorkspaceChanges } from "tau/host-extension";
import { isTurnSnapshotId } from "./turn-checkpoint-codec.js";
import { assertWorkspacePath } from "./workspace-paths.js";
import { describe, proposeMessage, parseUnifiedDiff } from "./git-diff.js";
import {
  CHECKPOINT_REF_GRACE_MS,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotOptions,
} from "./workspace-snapshot-types.js";
import type { SnapshotAdapter, SnapshotObjects } from "./snapshot-adapter.js";

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

async function filesystemFileDiff(
  filesystem: { before: FilesystemSnapshotManifest; after: FilesystemSnapshotManifest },
  path: string,
  options: DiffLoadOptions,
): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
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

/** Files, manifests, blob integrity and storage paths never escape this adapter. */
export function filesystemSnapshotAdapter(cwd: string): SnapshotAdapter {
  const canonical = () => realpath(cwd).catch(() => resolve(cwd));
  const checkpointRoot = async () => join(FILESYSTEM_SNAPSHOT_ROOT, filesystemWorkspaceKey(await canonical()), "checkpoints");
  return {
    kind: "filesystem",
    capture: (options, ref) => createFilesystemSnapshot(cwd, options, ref),
    async pair(beforeId, afterId) {
      const pair = await filesystemSnapshotPair(cwd, beforeId, afterId);
      if (!pair) return undefined;
      return {
        beforeTreeId: pair.before.treeId,
        afterTreeId: pair.after.treeId,
        assertRestorable: (label) => assertFilesystemRestoreable(cwd, pair, label),
        applyAfter: () => applyFilesystemSnapshot(cwd, pair.after),
        diff: (branch) => diffFilesystemSnapshots(pair, branch),
        fileDiff: (path, options) => filesystemFileDiff(pair, path, options),
        clone: (phase, target) => cloneFilesystemSnapshot(cwd, pair[phase].id, target, pair[phase].treeId),
      };
    },
    async remove(id, treeId) {
      const manifest = await readFilesystemSnapshot(cwd, id);
      if (treeId && manifest?.treeId !== treeId) return;
      await rm(filesystemManifestPath(await canonical(), id), { force: true });
    },
    async objects(prefix) {
      const result: SnapshotObjects = new Map();
      const root = await checkpointRoot();
      const directory = join(root, ...prefix.split("/").slice(3).filter(Boolean));
      for (const path of await filesystemManifests(directory)) {
        const id = `refs/tau/checkpoints/${relativePath(root, path).split(sep).join("/").slice(0, -5)}`;
        if (!isTurnSnapshotId(id)) continue;
        const manifest = await readFilesystemSnapshot(cwd, id);
        result.set(id, manifest ? { id: manifest.treeId, type: "tree" } : {});
      }
      return result;
    },
    async recent(ids, options) {
      const root = await canonical();
      const graceMs = options.graceMs ?? CHECKPOINT_REF_GRACE_MS;
      const now = options.now ?? Date.now();
      const recent = new Set<string>();
      if (graceMs <= 0) return recent;
      await Promise.all(ids.map(async (id) => {
        const stamp = await stat(filesystemManifestPath(root, id)).catch(() => undefined);
        if (stamp && now - stamp.mtimeMs < graceMs) recent.add(id);
      }));
      return recent;
    },
    async removeSession(sessionId) {
      await rm(join(await checkpointRoot(), sessionId), { recursive: true, force: true });
    },
    gc: () => gcFilesystemSnapshotBlobs(cwd),
  };
}
