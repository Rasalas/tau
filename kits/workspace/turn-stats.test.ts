import { describe, expect, it } from "vitest";
import { createTurnStatsFile, parseTurnStats, recordTurnStat, turnStatOf } from "./turn-stats.js";

const stat = (at: number, files = 2) => ({ added: 5, removed: 1, files, at });

describe("turn stats", () => {
  it("reads a checkpoint's counts, with the total when the file list is a preview", () => {
    expect(turnStatOf({ added: 3, removed: 2, files: [], fileCount: 40, endedAt: 9 })).toEqual({ added: 3, removed: 2, files: 40, at: 9 });
    expect(turnStatOf({ added: 3, removed: 2, files: [{ path: "a" } as never], endedAt: 9 }).files).toBe(1);
  });

  it("keeps the newest file-changing turn per thread and drops the oldest threads", () => {
    let stats = recordTurnStat({}, "a", stat(1));
    stats = recordTurnStat(stats, "a", stat(3, 0));
    expect(stats.a?.at).toBe(1);
    stats = recordTurnStat(stats, "a", stat(0));
    expect(stats.a?.at).toBe(1);
    stats = recordTurnStat(stats, "b", stat(2), 2);
    stats = recordTurnStat(stats, "c", stat(5), 2);
    expect(Object.keys(stats).sort()).toEqual(["b", "c"]);
  });

  it("ignores a file that is not a stat map", () => {
    expect(parseTurnStats("{nope")).toEqual({});
    expect(parseTurnStats(JSON.stringify({ a: stat(1), b: { added: "x" } }))).toEqual({ a: stat(1) });
  });

  it("writes the file once per batch of turns", async () => {
    const writes: string[] = [];
    const scheduled: Array<() => void> = [];
    const file = createTurnStatsFile({ read: async () => JSON.stringify({ old: stat(1) }), write: async (text) => { writes.push(text); }, schedule: (run) => scheduled.push(run) });
    await file.record("a", stat(2));
    await file.record("b", stat(3));
    await file.record("c", stat(4, 0));
    expect(Object.keys(await file.all()).sort()).toEqual(["a", "b", "old"]);
    scheduled.forEach((run) => run());
    expect(writes).toHaveLength(1);
    expect(Object.keys(JSON.parse(writes[0]!)).sort()).toEqual(["a", "b", "old"]);
  });
});
