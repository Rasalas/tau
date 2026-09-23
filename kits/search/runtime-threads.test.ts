import { describe, expect, it, vi } from "vitest";
import { threadTextsDelta } from "tau/host-extension";
import { RuntimeThreadIndex } from "./runtime-threads.js";

type Store = Array<{ tauThreadId: string; updatedAt: number; messages: Array<{ role: string; text: string }> }>;
const thread = (id: string, updatedAt: number, text = `said in ${id}`) => ({ tauThreadId: id, updatedAt, messages: [{ role: "user", text }] });

function setup(stores: Record<string, Store | Error>, options: { budgetChars?: number; limit?: number; rounds?: number } = {}) {
  let clock = 0;
  const ask = vi.fn(async (source: string, input: unknown) => {
    const store = stores[source];
    if (!store || store instanceof Error) throw store ?? new Error("no such kit");
    return threadTextsDelta(store, input);
  });
  const index = new RuntimeThreadIndex({ sources: Object.keys(stores), ask, now: () => clock, intervalMs: 5_000, ...options });
  return { index, ask, advance: (ms: number) => { clock += ms; } };
}

const ids = (index: RuntimeThreadIndex) => index.entries().map((entry) => entry.threadId);

describe("the index of other runtimes' threads", () => {
  it("asks each kit for what it lacks, at most every few seconds, and forgets what a kit no longer has", async () => {
    const codex: Store = [thread("c1", 10), thread("c2", 30)];
    const { index, ask, advance } = setup({ "tau.codex": codex, "tau.opencode": [thread("o1", 20)] });
    await index.sync();
    expect(ids(index)).toEqual(["c2", "o1", "c1"]);
    expect(index.entries()[0]!.texts).toEqual([{ role: "user", text: "said in c2" }]);

    codex[0] = thread("c1", 40, "changed");
    codex.splice(1, 1);
    await index.sync();
    expect(ask).toHaveBeenCalledTimes(2);
    advance(5_000);
    await index.sync();
    expect(ask).toHaveBeenLastCalledWith("tau.opencode", { known: { o1: 20 }, limit: 25 });
    expect(ask.mock.calls.find(([source], at) => source === "tau.codex" && at > 1)![1]).toEqual({ known: { c1: 10, c2: 30 }, limit: 25 });
    expect(ids(index)).toEqual(["c1", "o1"]);
    expect(index.entries()[0]!.texts[0]!.text).toBe("changed");
  });

  it("takes a few answers per sync and the rest with the next", async () => {
    const store = Array.from({ length: 7 }, (_, at) => thread(`t${at}`, at));
    const { index, advance } = setup({ "tau.codex": store }, { limit: 2, rounds: 2 });
    await index.sync();
    expect(ids(index)).toEqual(["t6", "t5", "t4", "t3"]);
    advance(5_000);
    await index.sync();
    expect(ids(index)).toHaveLength(7);
  });

  it("skips a kit that is off or cannot answer, and keeps the others", async () => {
    const { index } = setup({ "tau.antigravity": new Error("not active"), "tau.codex": [thread("c1", 1)] });
    await index.sync();
    expect(ids(index)).toEqual(["c1"]);
  });

  it("keeps within its budget by forgetting the oldest threads' text, without asking for them again", async () => {
    const store = [thread("old", 1, "a".repeat(60)), thread("mid", 2, "b".repeat(60)), thread("new", 3, "c".repeat(60))];
    const { index, ask, advance } = setup({ "tau.codex": store }, { budgetChars: 130 });
    await index.sync();
    expect(ids(index)).toEqual(["new", "mid"]);
    expect(index.size).toBe(120);
    advance(5_000);
    await index.sync();
    expect(ask).toHaveBeenLastCalledWith("tau.codex", { known: { old: 1, mid: 2, new: 3 }, limit: 25 });
    expect(ids(index)).toEqual(["new", "mid"]);
  });

  it("runs one sync at a time", async () => {
    const { index, ask } = setup({ "tau.codex": [thread("c1", 1)] });
    await Promise.all([index.sync(), index.sync()]);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
