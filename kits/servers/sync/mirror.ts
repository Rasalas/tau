import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { ServersStore, TargetFileSpec, TargetKey } from "../store.js";
import { gitCall, gitOk, type GitCall } from "./git.js";
import { isSyncPath } from "./paths.js";

/*
 * The mirror state: what Tau last read of a server, as a commit on
 * `refs/tau/server` in a bare shadow repository in the kit's state folder
 * (never in the project), plus `index.json` with size, mtime and mode per path.
 *
 * The shadow repository keeps every object itself and has no
 * `objects/info/alternates` file: with one, Git skips writing an object the
 * project already has and touches that object's mtime in the project instead,
 * and a `git gc` in the project could then take blobs the mirror needs.
 * The project's objects are only ever read, through the environment.
 */

export const MIRROR_REF = "refs/tau/server";
const ZERO_OID = "0".repeat(40);

export interface MirrorEntry {
  size: number;
  /** Seconds, as the server reported them. */
  mtime: number;
  /** Permission bits on the server. */
  mode: number;
  /** Git blob id of the content. */
  oid: string;
  /** SHA-256 of the content, to compare with a hash the server computes. */
  sha256: string;
}

export interface MirrorIndexFile extends Record<string, unknown> {
  commit: string;
  at: string;
  entries: Record<string, MirrorEntry>;
}

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

function decodeEntry(value: unknown): MirrorEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { size, mtime, mode, oid, sha256 } = value as Record<string, unknown>;
  if (typeof size !== "number" || typeof mtime !== "number" || typeof mode !== "number") return undefined;
  if (typeof oid !== "string" || !HEX40.test(oid) || typeof sha256 !== "string" || !HEX64.test(sha256)) return undefined;
  return { size, mtime, mode, oid, sha256 };
}

export const MIRROR_INDEX_FILE: TargetFileSpec<MirrorIndexFile> = {
  name: "index.json",
  version: 1,
  decode(value) {
    if (!value || typeof value !== "object") return undefined;
    const { commit, at, entries } = value as Record<string, unknown>;
    if (typeof commit !== "string" || !HEX40.test(commit) || typeof at !== "string" || !entries || typeof entries !== "object") return undefined;
    const decoded: Record<string, MirrorEntry> = {};
    for (const [path, entry] of Object.entries(entries as Record<string, unknown>)) {
      const ok = isSyncPath(path) ? decodeEntry(entry) : undefined;
      if (!ok) return undefined;
      decoded[path] = ok;
    }
    return { commit, at, entries: decoded };
  },
};

export function blobId(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

export function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function entryOf(data: Buffer, stamp: { mtime: number; mode: number }): MirrorEntry {
  return { size: data.length, mtime: stamp.mtime, mode: stamp.mode, oid: blobId(data), sha256: sha256Of(data) };
}

export interface MirrorOptions {
  git?: GitCall;
  /** The project's object folder, read (never written) for blobs the mirror does not hold. */
  projectObjects?: string;
}

export class Mirror {
  private readonly git: GitCall;

  constructor(readonly dir: string, private readonly options: MirrorOptions = {}) {
    this.git = options.git ?? gitCall();
  }

  // The user's config stays out: no hooks, no signing, no object format of theirs.
  private env(read = false): Record<string, string> {
    return {
      GIT_DIR: this.dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      ...(read && this.options.projectObjects ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: this.options.projectObjects } : {}),
    };
  }

  private run(args: readonly string[], options: { input?: Buffer | string; read?: boolean; env?: Record<string, string> } = {}): Promise<Buffer> {
    return gitOk(this.git, args, { cwd: this.dir, env: { ...this.env(options.read), ...options.env }, ...(options.input !== undefined ? { input: options.input } : {}) });
  }

  async ensure(): Promise<void> {
    if (await access(join(this.dir, "HEAD")).then(() => true, () => false)) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await gitOk(this.git, ["init", "--bare", "--quiet", "--initial-branch=tau", this.dir], { cwd: this.dir, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull } });
    await this.run(["config", "gc.auto", "0"]);
    await this.run(["config", "core.logAllRefUpdates", "false"]);
  }

  /** Writes a loose object in Node: no git process per file, and nothing asks the project's store. */
  async writeBlob(data: Buffer): Promise<string> {
    const oid = blobId(data);
    const folder = join(this.dir, "objects", oid.slice(0, 2));
    const file = join(folder, oid.slice(2));
    if (await access(file).then(() => true, () => false)) return oid;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temp = join(folder, `tmp_${randomBytes(6).toString("hex")}`);
    await writeFile(temp, deflateSync(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])), { mode: 0o444 });
    await rename(temp, file);
    return oid;
  }

  async head(): Promise<string | undefined> {
    const result = await this.git(["rev-parse", "--quiet", "--verify", `${MIRROR_REF}^{commit}`], { cwd: this.dir, env: this.env() });
    return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
  }

  /** A commit whose tree holds `entries` (blobs already written), on top of the current state; the ref is not moved. */
  async commit(entries: Readonly<Record<string, MirrorEntry>>, message: string): Promise<string> {
    const index = join(this.dir, `tau-index-${randomBytes(6).toString("hex")}`);
    try {
      const lines = Object.entries(entries).map(([path, entry]) => `${entry.mode & 0o111 ? "100755" : "100644"} ${entry.oid}\t${path}\0`).join("");
      await this.run(["update-index", "--add", "-z", "--index-info"], { input: lines, env: { GIT_INDEX_FILE: index } });
      const tree = (await this.run(["write-tree"], { env: { GIT_INDEX_FILE: index } })).toString("utf8").trim();
      const parent = await this.head();
      const identity = { GIT_AUTHOR_NAME: "Tau", GIT_AUTHOR_EMAIL: "tau@localhost", GIT_COMMITTER_NAME: "Tau", GIT_COMMITTER_EMAIL: "tau@localhost" };
      const args = ["commit-tree", "--no-gpg-sign", tree, ...(parent ? ["-p", parent] : []), "-m", message];
      return (await this.run(args, { env: identity })).toString("utf8").trim();
    } finally {
      await rm(index, { force: true });
    }
  }

  async setHead(commit: string, previous: string | undefined): Promise<void> {
    await this.run(["update-ref", "-m", "tau: mirror state", MIRROR_REF, commit, previous ?? ZERO_OID]);
  }

  /** Path → blob id of a commit's tree (the current state by default). */
  async files(commit?: string): Promise<Map<string, string>> {
    const ref = commit ?? MIRROR_REF;
    const output = (await this.run(["ls-tree", "-r", "-z", "--full-tree", ref])).toString("utf8");
    const files = new Map<string, string>();
    for (const record of output.split("\0")) {
      const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/su.exec(record);
      if (match) files.set(match[2]!, match[1]!);
    }
    return files;
  }

  /** A blob from the mirror, or from the project's objects when it is only there. */
  async readBlob(oid: string): Promise<Buffer> {
    if (!HEX40.test(oid)) throw new Error(`Not a blob id: ${oid}`);
    return this.run(["cat-file", "blob", oid], { read: true });
  }
}

export interface MirrorState {
  commit: string;
  at: string;
  entries: Map<string, MirrorEntry>;
}

/**
 * The last recorded state. `index.json` is written before the ref moves, so
 * after a crash in between the index wins and the ref is set to it.
 */
export async function loadMirrorState(store: ServersStore, key: TargetKey, mirror: Mirror): Promise<MirrorState | undefined> {
  const index = await store.read(key, MIRROR_INDEX_FILE);
  if (!index) return undefined;
  const head = await mirror.head().catch(() => undefined);
  if (head !== index.commit) {
    try {
      await mirror.setHead(index.commit, head);
    } catch {
      return undefined;
    }
  }
  return { commit: index.commit, at: index.at, entries: new Map(Object.entries(index.entries)) };
}

export async function saveMirrorState(store: ServersStore, key: TargetKey, mirror: Mirror, entries: ReadonlyMap<string, MirrorEntry>, message: string): Promise<MirrorState> {
  await mirror.ensure();
  const sorted = Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const previous = await mirror.head();
  const commit = await mirror.commit(sorted, message);
  const at = new Date().toISOString();
  await store.write(key, MIRROR_INDEX_FILE, { commit, at, entries: sorted });
  await mirror.setHead(commit, previous);
  return { commit, at, entries: new Map(Object.entries(sorted)) };
}
