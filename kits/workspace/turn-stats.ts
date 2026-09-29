import type { TurnStat } from "./protocol.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";

/** Threads the file keeps; the rail shows the newest ones anyway. */
export const TURN_STATS_LIMIT = 1_000;

export function turnStatOf(checkpoint: Pick<UiTurnCheckpoint, "added" | "removed" | "files" | "fileCount" | "endedAt">): TurnStat {
  return { added: checkpoint.added, removed: checkpoint.removed, files: checkpoint.fileCount ?? checkpoint.files.length, at: checkpoint.endedAt };
}

/**
 * The newest file-changing turn per thread. A turn that changed nothing
 * leaves the thread's last stat alone, unless it is that same turn read
 * again (a revised record); the oldest threads drop off at `limit`.
 */
export function recordTurnStat(stats: Readonly<Record<string, TurnStat>>, sessionId: string, stat: TurnStat, limit = TURN_STATS_LIMIT): Record<string, TurnStat> {
  const previous = stats[sessionId];
  if (stat.files === 0) {
    const next = { ...stats };
    if (previous?.at === stat.at) delete next[sessionId];
    return next;
  }
  if (previous && previous.at > stat.at) return { ...stats };
  const next = { ...stats, [sessionId]: stat };
  const ids = Object.keys(next);
  if (ids.length <= limit) return next;
  const keep = new Set(ids.sort((left, right) => next[right]!.at - next[left]!.at).slice(0, limit));
  return Object.fromEntries(Object.entries(next).filter(([id]) => keep.has(id)));
}

/** Reads what the file holds, dropping anything that is not a stat. */
export function parseTurnStats(text: string | undefined): Record<string, TurnStat> {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, Partial<TurnStat>>;
    return Object.fromEntries(Object.entries(raw).filter(([, stat]) =>
      typeof stat?.added === "number" && typeof stat.removed === "number" && typeof stat.files === "number" && typeof stat.at === "number")) as Record<string, TurnStat>;
  } catch {
    return {};
  }
}

/** The host's copy: loaded once, written back a moment after each change. */
export function createTurnStatsFile(io: { read(): Promise<string | undefined>; write(text: string): Promise<void>; schedule(run: () => void): void }) {
  let stats: Record<string, TurnStat> | undefined;
  let loading: Promise<Record<string, TurnStat>> | undefined;
  let dirty = false;
  const load = async (): Promise<Record<string, TurnStat>> => {
    await (loading ??= io.read().then(parseTurnStats, () => ({})).then((read) => { stats ??= read; return read; }));
    return stats!;
  };
  const flush = () => {
    if (!dirty || !stats) return;
    dirty = false;
    void io.write(JSON.stringify(stats)).catch(() => { dirty = true; });
  };
  return {
    all: async () => ({ ...(await load()) }),
    async record(sessionId: string, stat: TurnStat): Promise<void> {
      const current = await load();
      stats = recordTurnStat(current, sessionId, stat);
      if (stats[sessionId] === current[sessionId]) return;
      dirty = true;
      io.schedule(flush);
    },
    flush,
  };
}
