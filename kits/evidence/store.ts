import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import type { EvidenceFrame, EvidenceThread, EvidenceTurn } from "./protocol.js";

const INDEX = "index.json";
const VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;

interface ThreadIndex {
  threadId: string;
  /** The project, whose settings decide how long its frames stay. */
  cwd: string;
  turns: EvidenceTurn[];
}

export interface FrameBytes {
  frame: Buffer;
  thumb: Buffer;
}

export interface StoreLimits {
  framesPerTurn: number;
  threadBytes: number;
}

/** A thread's folder: its id when that is a plain name, else a hash of it. */
export function folderOf(threadId: string): string {
  return /^[A-Za-z0-9_-]{1,96}$/u.test(threadId) ? threadId : createHash("sha256").update(threadId).digest("hex").slice(0, 40);
}

const bytesOf = (turns: readonly EvidenceTurn[]): number =>
  turns.reduce((sum, turn) => sum + turn.frames.reduce((inner, frame) => inner + frame.size + frame.thumbSize, 0), 0);

function decodeIndex(value: unknown): ThreadIndex | undefined {
  const record = value && typeof value === "object" ? value as Partial<ThreadIndex> : undefined;
  if (!record || typeof record.threadId !== "string" || !Array.isArray(record.turns)) return undefined;
  const turns = record.turns.filter((turn): turn is EvidenceTurn =>
    Boolean(turn) && typeof turn.turnId === "string" && typeof turn.startedAt === "number" && Array.isArray(turn.frames));
  return { threadId: record.threadId, cwd: typeof record.cwd === "string" ? record.cwd : "", turns };
}

/**
 * The frames on disk, one folder per thread under the kit's `stateDir`: an
 * index and two JPEGs a frame. Work on one thread runs in order; the limits
 * hold after every write.
 */
export class EvidenceStore {
  private readonly cache = new Map<string, ThreadIndex>();

  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string, private readonly log: (label: string, detail?: string) => void = () => undefined) {}

  private folder(threadId: string): string {
    return join(this.root, "threads", folderOf(threadId));
  }

  private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(threadId, next);
    void next.catch(() => undefined).finally(() => { if (this.queues.get(threadId) === next) this.queues.delete(threadId); });
    return next;
  }

  private async index(threadId: string): Promise<ThreadIndex> {
    const cached = this.cache.get(threadId);
    if (cached) return cached;
    const read = await readPersistedJson(join(this.folder(threadId), INDEX), { expectedVersion: VERSION, decode: decodeIndex, logger: { warn: (message) => this.log("evidence.index", message) } });
    const index = read?.data.threadId === threadId ? read.data : { threadId, cwd: "", turns: [] };
    this.cache.set(threadId, index);
    return index;
  }

  private async save(index: ThreadIndex): Promise<void> {
    if (index.turns.length === 0) {
      this.cache.delete(index.threadId);
      await rm(this.folder(index.threadId), { recursive: true, force: true });
      return;
    }
    await writePersistedJson(join(this.folder(index.threadId), INDEX), VERSION, { threadId: index.threadId, cwd: index.cwd, turns: index.turns });
  }

  private async drop(threadId: string, frames: readonly EvidenceFrame[]): Promise<void> {
    const folder = this.folder(threadId);
    await Promise.all(frames.flatMap((frame) => [
      rm(join(folder, `${frame.id}.jpg`), { force: true }),
      rm(join(folder, `${frame.id}.thumb.jpg`), { force: true }),
    ]));
  }

  async list(threadId: string): Promise<EvidenceThread> {
    const index = await this.index(threadId);
    return { threadId, turns: index.turns.filter((turn) => turn.frames.length > 0) };
  }

  /** Every thread with frames on disk, whether or not it was read since the start. */
  async threads(): Promise<string[]> {
    const folders = await readdir(join(this.root, "threads")).catch(() => [] as string[]);
    const ids = await Promise.all(folders.map(async (folder) => {
      const read = await readPersistedJson(join(this.root, "threads", folder, INDEX), { expectedVersion: VERSION, decode: decodeIndex }).catch(() => undefined);
      return read?.data.threadId;
    }));
    return ids.filter((id): id is string => Boolean(id));
  }

  /**
   * Keeps a frame for a turn and answers it, or `undefined` when the limits
   * leave it no room. The turn's first frame and the agent's own are kept
   * longest; older turns go before the current one is thinned.
   */
  add(
    threadId: string,
    cwd: string,
    turn: { turnId: string; startedAt: number },
    frame: Omit<EvidenceFrame, "id" | "size" | "thumbSize">,
    bytes: FrameBytes,
    limits: StoreLimits,
  ): Promise<EvidenceFrame | undefined> {
    return this.serial(threadId, async () => {
      const index = await this.index(threadId);
      if (cwd) index.cwd = cwd;
      let entry = index.turns.find((candidate) => candidate.turnId === turn.turnId);
      if (!entry) {
        entry = { turnId: turn.turnId, startedAt: turn.startedAt, frames: [] };
        index.turns.push(entry);
      }
      const kept: EvidenceFrame = { ...frame, id: randomUUID(), size: bytes.frame.length, thumbSize: bytes.thumb.length };
      entry.frames.push(kept);
      const dropped: EvidenceFrame[] = [];
      const thin = (target: EvidenceTurn): boolean => {
        const position = target.frames.findIndex((candidate, at) => at > 0 && candidate.trigger !== "agent" && candidate !== kept);
        if (position < 0) return false;
        dropped.push(...target.frames.splice(position, 1));
        return true;
      };
      while (entry.frames.length > limits.framesPerTurn) {
        if (!thin(entry)) { entry.frames.splice(entry.frames.indexOf(kept), 1); await this.save(index); return undefined; }
      }
      while (bytesOf(index.turns) > limits.threadBytes) {
        const oldest = index.turns.find((candidate) => candidate !== entry && candidate.frames.length > 0);
        if (oldest) { dropped.push(...oldest.frames.splice(0)); continue; }
        if (!thin(entry)) { entry.frames.splice(entry.frames.indexOf(kept), 1); break; }
      }
      index.turns = index.turns.filter((candidate) => candidate.frames.length > 0 || candidate === entry);
      const stays = entry.frames.includes(kept);
      if (stays) {
        await mkdir(this.folder(threadId), { recursive: true, mode: 0o700 });
        await writeFile(join(this.folder(threadId), `${kept.id}.jpg`), bytes.frame, { mode: 0o600 });
        await writeFile(join(this.folder(threadId), `${kept.id}.thumb.jpg`), bytes.thumb, { mode: 0o600 });
      }
      if (entry.frames.length === 0) index.turns = index.turns.filter((candidate) => candidate !== entry);
      await this.save(index);
      await this.drop(threadId, dropped);
      return stays ? kept : undefined;
    });
  }

  /** Records when a turn settled; a turn without frames is not recorded at all. */
  endTurn(threadId: string, turnId: string, endedAt: number): Promise<boolean> {
    return this.serial(threadId, async () => {
      const index = await this.index(threadId);
      const turn = index.turns.find((candidate) => candidate.turnId === turnId);
      if (!turn || turn.endedAt !== undefined) return false;
      turn.endedAt = endedAt;
      await this.save(index);
      return true;
    });
  }

  image(threadId: string, frameId: string, thumb = false): Promise<Buffer | undefined> {
    return this.serial(threadId, async () => {
      const index = await this.index(threadId);
      if (!index.turns.some((turn) => turn.frames.some((frame) => frame.id === frameId))) return undefined;
      return readFile(join(this.folder(threadId), `${frameId}${thumb ? ".thumb" : ""}.jpg`)).catch(() => undefined);
    });
  }

  frame(threadId: string, frameId: string): Promise<{ turn: EvidenceTurn; frame: EvidenceFrame } | undefined> {
    return this.serial(threadId, async () => {
      for (const turn of (await this.index(threadId)).turns) {
        const frame = turn.frames.find((candidate) => candidate.id === frameId);
        if (frame) return { turn, frame };
      }
      return undefined;
    });
  }

  deleteTurn(threadId: string, turnId: string): Promise<boolean> {
    return this.serial(threadId, async () => {
      const index = await this.index(threadId);
      const turn = index.turns.find((candidate) => candidate.turnId === turnId);
      if (!turn) return false;
      index.turns = index.turns.filter((candidate) => candidate !== turn);
      await this.save(index);
      await this.drop(threadId, turn.frames);
      return true;
    });
  }

  deleteThread(threadId: string): Promise<void> {
    return this.serial(threadId, async () => {
      this.cache.delete(threadId);
      await rm(this.folder(threadId), { recursive: true, force: true });
    });
  }

  /**
   * Drops every turn older than its project keeps frames; answers the threads
   * that changed. `retentionDays` is asked once per project.
   */
  async sweep(retentionDays: (cwd: string) => Promise<number>, now = Date.now()): Promise<string[]> {
    const days = new Map<string, Promise<number>>();
    const changed: string[] = [];
    for (const threadId of await this.threads()) {
      const removed = await this.serial(threadId, async () => {
        const index = await this.index(threadId);
        let keepDays = days.get(index.cwd);
        if (!keepDays) days.set(index.cwd, keepDays = retentionDays(index.cwd));
        const cutoff = now - await keepDays * DAY_MS;
        const old = index.turns.filter((turn) => (turn.endedAt ?? turn.frames.at(-1)?.at ?? turn.startedAt) < cutoff);
        if (old.length === 0) return false;
        index.turns = index.turns.filter((turn) => !old.includes(turn));
        await this.save(index);
        await this.drop(threadId, old.flatMap((turn) => turn.frames));
        return true;
      });
      if (removed) changed.push(threadId);
    }
    return changed;
  }

  /** Lets go of a thread's cached index; the disk keeps it. */
  forget(threadId: string): void {
    if (!this.queues.has(threadId)) this.cache.delete(threadId);
  }
}
