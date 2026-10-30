import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentMessageIndex } from "./persistent-index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(index.truncated).toBe(true);
    advance(5_000);
    await index.sync();
    expect(ids(index)).toHaveLength(7);
    expect(index.truncated).toBe(false);
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
    expect(index.truncated).toBe(true);
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

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function diskIndex() {
  const root = await mkdtemp(join(tmpdir(), "tau-runtime-search-")); roots.push(root);
  return { root, disk: new PersistentMessageIndex(root) };
}

it("skips complete canonical aliases without stalling a catalog and restores them immediately for an external-current thread", async () => {
  const { disk } = await diskIndex();
  let canonical = true; let revision = 1;
  const stored = [thread("alias", 2, "inherited beacon"), thread("other", 1, "ordinary nebula")];
  const index = new RuntimeThreadIndex({ sources: ["runtime"], persistent: disk, limit: 1, now: () => 0,
    ignore: id => canonical && id === "alias", ignoreRevision: () => revision,
    ask: async (_source, input) => threadTextsDelta(stored, input),
  });
  await index.sync();
  expect((await disk.catalog()).map(entry => entry.id)).toEqual(["other"]);
  expect(index.coverage()).toEqual([{ source: "runtime", state: "complete" }]);
  canonical = false; revision++;
  await index.sync();
  expect((await disk.catalog()).map(entry => entry.id).sort()).toEqual(["alias", "other"]);
  canonical = true; revision++;
  await index.sync();
  expect((await disk.catalog()).map(entry => entry.id)).toEqual(["other"]);
});
async function matches(index: RuntimeThreadIndex, token: string) {
  const found = [];
  for await (const match of index.search([token])) found.push(match);
  return found;
}

describe("persistent runtime exports", () => {
  it("drains all export pages before searching, without discarding old text at the RAM budget", async () => {
    const { disk } = await diskIndex();
    const store = Array.from({ length: 7 }, (_, at) => thread(`t${at}`, at, at === 0 ? "old crystal" : "other"));
    const index = new RuntimeThreadIndex({ persistent: disk, sources: ["runtime"], limit: 2, rounds: 1, budgetChars: 1, ask: async (_, input) => threadTextsDelta(store, input) });
    await index.sync();
    expect((await matches(index, "crystal")).map((entry) => entry.threadId)).toEqual(["t0"]);
    expect(index.size).toBe(0);
    expect(await disk.catalog()).toHaveLength(7);
  });

  it("restores known versions after restart and replaces or removes them without stale or cross-source text", async () => {
    const { root, disk } = await diskIndex();
    const stores: Record<string, Store> = { a: [thread("same", 1, "alpha crystal")], b: [thread("same", 2, "beta nova")] };
    const ask = vi.fn(async (source: string, input: unknown) => threadTextsDelta(stores[source]!, input));
    const first = new RuntimeThreadIndex({ persistent: disk, sources: ["a", "b"], ask });
    await first.sync();
    const restarted = new RuntimeThreadIndex({ persistent: new PersistentMessageIndex(root), sources: ["a", "b"], intervalMs: 0, ask });
    ask.mockClear();
    await restarted.sync();
    expect(ask.mock.calls).toEqual([["a", { protocol: 2, known: { same: 1 }, knownVersions: {}, limit: 25 }],
      ["b", { protocol: 2, known: { same: 2 }, knownVersions: {}, limit: 25 }]]);
    stores.a = []; stores.b = [thread("same", 3, "new pulsar")];
    await restarted.sync();
    expect(await matches(restarted, "crystal")).toEqual([]);
    expect(await matches(restarted, "nova")).toEqual([]);
    expect(await matches(restarted, "pulsar")).toMatchObject([{ threadId: "same", match: { snippet: "new pulsar" } }]);
    expect(await disk.catalog()).toMatchObject([{ source: "b", id: "same", updatedAt: 3 }]);
  });

  it("does not return a persisted export while its source cannot validate the catalog", async () => {
    const { disk } = await diskIndex();
    await disk.putRuntime("runtime", "gone", 1, [{ role: "user", text: "stale crystal" }]);
    const index = new RuntimeThreadIndex({ persistent: disk, sources: ["runtime"], ask: async () => { throw new Error("disabled"); } });
    await index.sync();
    expect(await matches(index, "crystal")).toEqual([]);
  });
});

describe("complete versioned runtime exports", () => {
  it("finds text past 64k, spans pages within one message and never combines messages", async () => {
    const { disk } = await diskIndex();
    const store = [thread("large", 1, "opening " + "x".repeat(63_990) + "😀 crystal " + "z".repeat(90_000) + " ending")];
    store[0]!.messages.push({ role: "assistant", text: "separate" });
    const ask = vi.fn(async (_: string, input: unknown) => threadTextsDelta(store, input));
    const index = new RuntimeThreadIndex({ persistent: disk, sources: ["runtime"], budgetChars: 1, ask });
    await index.sync();
    expect(await matches(index, "crystal")).toHaveLength(1);
    const distant = [];
    for await (const match of index.search(["opening", "ending"])) distant.push(match);
    expect(distant).toHaveLength(1);
    const crossed = [];
    for await (const match of index.search(["opening", "separate"])) crossed.push(match);
    expect(crossed).toEqual([]);
    expect(ask.mock.calls.filter(([, input]) => (input as { page?: unknown }).page).length).toBeGreaterThan(2);
    expect(index.coverage()).toEqual([{ source: "runtime", state: "complete" }]);
    expect(index.size).toBe(0);
  });

  it("refreshes same-timestamp changes after restart without reexporting unchanged text", async () => {
    const { root, disk } = await diskIndex();
    const store = [thread("same", 5, "first crystal")];
    const ask = vi.fn(async (_: string, input: unknown) => threadTextsDelta(store, input));
    await new RuntimeThreadIndex({ persistent: disk, sources: ["runtime"], ask }).sync();
    const restarted = new RuntimeThreadIndex({ persistent: new PersistentMessageIndex(root), sources: ["runtime"], intervalMs: 0, ask });
    ask.mockClear();
    await restarted.sync();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await matches(restarted, "crystal")).toHaveLength(1);
    store[0]!.messages[0]!.text = "other nova";
    await restarted.sync();
    expect(await matches(restarted, "crystal")).toEqual([]);
    expect(await matches(restarted, "nova")).toHaveLength(1);
    store.splice(0);
    const deleted = new RuntimeThreadIndex({ persistent: new PersistentMessageIndex(root), sources: ["runtime"], ask });
    await deleted.sync();
    expect(await disk.catalog()).toEqual([]);
    expect(await matches(deleted, "nova")).toEqual([]);
  });

  it.each(["edit", "delete"])("does not publish half a generation on %s while paging, and retries later", async (change) => {
    const { disk } = await diskIndex();
    const store = [thread("changing", 1, "old crystal")];
    let mutate = false, pageCalls = 0;
    const ask = async (_: string, input: unknown) => {
      const fields = input as { page?: { cursor?: string } };
      if (fields.page && mutate && ++pageCalls === 2) {
        if (change === "delete") store.splice(0);
        else store[0]!.messages[0]!.text = "stable comet";
      }
      return threadTextsDelta(store, input);
    };
    const index = new RuntimeThreadIndex({ persistent: disk, sources: ["runtime"], intervalMs: 0, ask });
    await index.sync();
    store[0]!.messages[0]!.text = "partial beacon " + "x".repeat(140_000);
    mutate = true;
    await index.sync();
    expect(await matches(index, "beacon")).toEqual([]);
    expect(await matches(index, "crystal")).toEqual([]);
    // The atomic disk file is still the previous complete generation.
    expect(await disk.searchRuntime("runtime", "changing", ["crystal"])).toBeDefined();
    expect(index.coverage()).toMatchObject([{ state: "partial", reason: "export-failed" }]);
    mutate = false;
    await index.sync();
    if (change === "delete") expect(await disk.catalog()).toEqual([]);
    else expect(await matches(index, "comet")).toHaveLength(1);
    expect(index.coverage()).toMatchObject([{ state: "complete" }]);
  });

  it("processes tombstones and later catalog pages even if a large newer export fails", async () => {
    const { disk } = await diskIndex();
    await disk.putRuntime("runtime", "gone", 1, [{ role: "user", text: "deleted crystal" }]);
    const store = [thread("bad", 3, "x".repeat(100_000)), thread("good", 2, "good comet")];
    const index = new RuntimeThreadIndex({ persistent: disk, sources: ["runtime"], limit: 1,
      ask: async (_, input) => {
        if (input.page?.threadId === "bad") throw new Error("export failed");
        return threadTextsDelta(store, input);
      } });
    await index.sync();
    expect(await matches(index, "crystal")).toEqual([]);
    expect(await matches(index, "comet")).toHaveLength(1);
    expect((await disk.catalog()).some(entry => entry.id === "gone")).toBe(false);
    expect(index.coverage()).toMatchObject([{ state: "partial" }]);
  });

  it("labels older providers as prefix-only and retries a strict old request shape", async () => {
    const { disk } = await diskIndex();
    const store = [thread("old", 1, "prefix crystal " + "x".repeat(80_000) + " unseen comet")];
    const ask = vi.fn(async (_: string, input: unknown) => {
      const { protocol, ...legacy } = input as { protocol?: number };
      if (protocol) throw new Error("unknown field");
      return threadTextsDelta(store, legacy);
    });
    const index = new RuntimeThreadIndex({ persistent: disk, sources: ["old-machine"], ask });
    await index.sync();
    expect(await matches(index, "crystal")).toHaveLength(1);
    expect(await matches(index, "comet")).toEqual([]);
    expect(index.coverage()).toEqual([{ source: "old-machine", state: "partial", reason: "legacy-prefix" }]);
    expect(ask.mock.calls[1]![1]).toEqual({ known: {}, limit: 25 });
  });
});

it("handles an old provider that ignores opt-in fields without claiming full coverage", async () => {
  const { disk } = await diskIndex();
  const index = new RuntimeThreadIndex({ persistent: disk, sources: ["old"], ask: async (_, input) =>
    threadTextsDelta([thread("prefix", 1, "legacy crystal")], { known: input.known, limit: input.limit }) });
  await index.sync();
  expect(await matches(index, "crystal")).toHaveLength(1);
  expect(index.coverage()).toMatchObject([{ source: "old", state: "partial", reason: "legacy-prefix" }]);
});
