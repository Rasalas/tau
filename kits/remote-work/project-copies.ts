import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, type HostMachineServices } from "tau/host-extension";
import { createGitRunner, type GitRunner } from "./git.js";
import { readRepoIdentity } from "./identity.js";
import { collectIgnoredFiles } from "./ignored-files.js";
import { DOWNLOAD_PIECE_BYTES, REMOTE_WORK_EXTENSION_ID, transferRef, type IgnoredFilePayload, type RepoIdentity } from "./protocol.js";
import { captureTransferState, createTransferBundle } from "./repo-transfer.js";

export interface ProjectSnapshot {
  id: string;
  repo: RepoIdentity;
  base: string;
}

export interface ProjectBundle {
  size: number;
  sha256?: string;
}

interface ExportedProject {
  snapshot: ProjectSnapshot;
  root: string;
  bundle?: string;
  bundled?: Promise<ProjectBundle>;
  files: IgnoredFilePayload[];
  device?: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Pulling a project needs no agents connection from its source back to the receiver. */
export class ProjectCopies {
  private readonly exports = new Map<string, ExportedProject>();
  private readonly git: GitRunner;

  constructor(private readonly directory: string) {
    this.git = createGitRunner({ config: [`core.hooksPath=${join(directory, "no-hooks")}`, "core.fsmonitor=false"] });
  }

  /** Exports are temporary and their device handles do not survive a host restart. */
  async open(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async capture(root: string, ignored: string[], device?: string): Promise<ProjectSnapshot> {
    const id = randomBytes(16).toString("hex");
    const directory = join(this.directory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, "no-hooks"), { recursive: true, mode: 0o700 });
    const gitRunner = this.git;
    try {
      const repo = await readRepoIdentity(root, gitRunner);
      const state = await captureTransferState({ root: repo.root, transfer: id, machineName: "another machine", git: gitRunner });
      const snapshot: ProjectSnapshot = {
        id, repo: { key: repo.key, name: repo.name, source: repo.source, ...(repo.origin ? { origin: repo.origin } : {}) },
        base: state.base,
      };
      const files = await collectIgnoredFiles(repo.root, ignored, gitRunner);
      const timer = setTimeout(() => { void this.release(id).catch(() => undefined); }, 60 * 60_000);
      timer.unref?.();
      this.exports.set(id, { snapshot, root: repo.root, files, device, timer });
      return snapshot;
    } catch (error) {
      await gitRunner(root, ["update-ref", "-d", transferRef(id)]).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private get(id: string, device?: string): ExportedProject {
    const found = this.exports.get(id);
    if (!found || found.device && device && found.device !== device) throw new HostCommandError("This machine has no project copy for this device.");
    return found;
  }

  /** The receiver names the commits it already has before any bundle is built. */
  bundle(id: string, tips: readonly string[], device?: string): Promise<ProjectBundle> {
    const found = this.get(id, device);
    if (!found.bundled) found.bundled = createTransferBundle({ root: found.root, transfer: id, tips, directory: join(this.directory, id), git: this.git }).then((bundle) => {
      found.bundle = bundle?.path;
      return bundle ? { size: bundle.size, sha256: bundle.sha256 } : { size: 0 };
    });
    return found.bundled;
  }

  files(id: string, device?: string): IgnoredFilePayload[] {
    return structuredClone(this.get(id, device).files);
  }

  async read(id: string, offset: number, length: number, device?: string): Promise<string> {
    const found = this.get(id, device);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > DOWNLOAD_PIECE_BYTES) {
      throw new HostCommandError("Invalid project copy range.");
    }
    if (!found.bundle) throw new HostCommandError("This project copy has no bundle to read.");
    const file = await open(found.bundle, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString("base64");
    } finally { await file.close(); }
  }

  async release(id: string, device?: string): Promise<void> {
    const found = this.get(id, device);
    clearTimeout(found.timer);
    this.exports.delete(id);
    try { await this.git(found.root, ["update-ref", "-d", transferRef(id)]); }
    finally { await rm(join(this.directory, id), { recursive: true, force: true }); }
  }

  async close(): Promise<void> {
    await Promise.all([...this.exports.keys()].map((id) => this.release(id)));
  }
}

/** Downloads bounded pieces to disk and verifies the complete bundle before Git reads it. */
export async function downloadProject(machines: HostMachineServices, machine: string, snapshot: ProjectBundle & { id: string }, path: string): Promise<void> {
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 1 || !snapshot.sha256 || !/^[0-9a-f]{64}$/u.test(snapshot.sha256)) throw new HostCommandError("Invalid project copy manifest.");
  const hash = createHash("sha256");
  const file = await open(path, "wx", 0o600);
  try {
    for (let offset = 0; offset < snapshot.size;) {
      const length = Math.min(DOWNLOAD_PIECE_BYTES, snapshot.size - offset);
      const answer = await machines.call(machine, REMOTE_WORK_EXTENSION_ID, "project-copy-read", { id: snapshot.id, offset, length }) as { data: string };
      const bytes = Buffer.from(answer.data, "base64");
      if (bytes.length !== length) throw new HostCommandError("The project copy ended before the whole bundle arrived.");
      hash.update(bytes);
      await file.writeFile(bytes);
      offset += bytes.length;
    }
    if (hash.digest("hex") !== snapshot.sha256) throw new HostCommandError("The project copy arrived with another checksum.");
  } finally { await file.close(); }
}
