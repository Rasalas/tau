import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceStore, folderOf } from "./store.js";
import type { EvidenceTrigger } from "./protocol.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tau-evidence-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const bytes = (size: number) => ({ frame: Buffer.alloc(size, 1), thumb: Buffer.alloc(10, 2) });
const shot = (at: number, trigger: EvidenceTrigger = "action") => ({ at, source: "preview" as const, trigger, caption: `at ${String(at)}`, width: 960, height: 600, mediaType: "image/jpeg" });
const roomy = { framesPerTurn: 60, threadBytes: 1_000_000 };

describe("EvidenceStore", () => {
  it("keeps frames per turn on disk and reads them back after a restart", async () => {
    const store = new EvidenceStore(root);
    const frame = await store.add("thread-1", "/project", { turnId: "t1", startedAt: 1 }, shot(2), bytes(100), roomy);
    expect(frame).toMatchObject({ caption: "at 2", size: 100, thumbSize: 10 });
    expect(await store.endTurn("thread-1", "t1", 5)).toBe(true);

    const again = new EvidenceStore(root);
    expect(await again.list("thread-1")).toEqual({ threadId: "thread-1", turns: [{ turnId: "t1", startedAt: 1, endedAt: 5, frames: [frame] }] });
    expect((await again.image("thread-1", frame!.id))?.length).toBe(100);
    expect((await again.image("thread-1", frame!.id, true))?.length).toBe(10);
    expect(await again.image("thread-1", "not-a-frame")).toBeUndefined();
  });

  it("thins a full turn from its second frame on, keeping the first and the agent's own", async () => {
    const store = new EvidenceStore(root);
    const limits = { framesPerTurn: 3, threadBytes: 1_000_000 };
    for (const [at, trigger] of [[1, "action"], [2, "agent"], [3, "action"], [4, "action"], [5, "action"]] as const) {
      await store.add("t", "", { turnId: "turn", startedAt: 0 }, shot(at, trigger), bytes(10), limits);
    }
    const [turn] = (await store.list("t")).turns;
    expect(turn!.frames.map((frame) => frame.at)).toEqual([1, 2, 5]);
    expect(await readdir(join(root, "threads", "t"))).toHaveLength(1 + 3 * 2);
  });

  it("lets older turns go first when a thread runs out of space", async () => {
    const store = new EvidenceStore(root);
    const limits = { framesPerTurn: 60, threadBytes: 250 };
    await store.add("t", "", { turnId: "old", startedAt: 0 }, shot(1), bytes(100), limits);
    await store.add("t", "", { turnId: "new", startedAt: 10 }, shot(11), bytes(100), limits);
    await store.add("t", "", { turnId: "new", startedAt: 10 }, shot(12), bytes(100), limits);
    expect((await store.list("t")).turns.map((turn) => turn.turnId)).toEqual(["new"]);
  });

  it("drops turns older than their project keeps pictures, and a deleted thread whole", async () => {
    const store = new EvidenceStore(root);
    const day = 24 * 60 * 60_000;
    await store.add("a", "/keeps-long", { turnId: "t", startedAt: 0 }, shot(1), bytes(10), roomy);
    await store.endTurn("a", "t", 1);
    await store.add("b", "/keeps-short", { turnId: "t", startedAt: 0 }, shot(1), bytes(10), roomy);
    await store.endTurn("b", "t", 1);
    const changed = await store.sweep(async (cwd) => cwd === "/keeps-long" ? 30 : 3, 5 * day);
    expect(changed).toEqual(["b"]);
    expect(await readdir(join(root, "threads"))).toEqual(["a"]);

    await store.deleteThread("a");
    expect(await readdir(join(root, "threads"))).toEqual([]);
  });

  it("names a folder by the thread id only when that is a plain name", () => {
    expect(folderOf("019a-thread_1")).toBe("019a-thread_1");
    expect(folderOf("../escape")).toMatch(/^[0-9a-f]{40}$/u);
  });
});
