import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpSessionStore } from "./session-store.js";

const directories: string[] = [];
const stores: AcpSessionStore[] = [];
function tracked<T extends AcpSessionStore>(liveStore: T): T { stores.push(liveStore); return liveStore; }
afterEach(async () => {
  const closed = await Promise.allSettled(stores.splice(0).map((liveStore) => liveStore.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const result of closed) if (result.status === "rejected") throw result.reason;
});

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "tau-acp-store-"));
  directories.push(directory);
  return { make: () => tracked(new AcpSessionStore({ filePath: join(directory, "tau", "fake-runtime-sessions.json"), backendKind: "fake", agent: "Fake", now: () => 7 })) };
}

const total = (turns: number) => ({ inputTokens: 10 * turns, outputTokens: 2 * turns, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12 * turns, costUsd: 0.5 * turns, turns });
const turn = (at: number, model = "m-1") => ({ provider: "xai", model, ...total(1), at });

describe("AcpSessionStore shared database", () => {
  it("keeps other stores' model catalogs across thread and catalog writes", async () => {
    const { make } = await store();
    const first = make();
    const second = make();
    const model = (id: string) => ({ id, name: id, efforts: [] });
    await first.setModels([model("old-default")]);
    await second.list();
    await first.setModels([model("default-model")]);
    await second.setModels([model("work-model")], "work");
    await first.ensure("first", "/repo");
    await second.ensure("second", "/repo");
    expect(await make().listModels()).toEqual([model("default-model")]);
    expect(await make().listModels("work")).toEqual([model("work-model")]);
  });

  it("does not revert another store's edit or resurrect its deleted thread", async () => {
    const { make } = await store();
    const first = make();
    await first.ensure("shared", "/repo");
    const second = make();
    await second.list();
    await first.setTitle("shared", "/repo", "Changed", "renamed");
    await second.ensure("second", "/repo");
    expect(await make().get("shared")).toMatchObject({ title: "Changed" });
    const taken = await first.take("shared");
    await second.ensure("third", "/repo");
    expect(await make().get("shared")).toBeUndefined();
    await first.put("shared", taken);
    await second.ensure("fourth", "/repo");
    expect(await make().get("shared")).toEqual(taken);
    expect((await make().list()).map((record) => record.tauThreadId).sort()).toEqual(["fourth", "second", "shared", "third"]);
  });

  it("preserves threads when stores write concurrently", async () => {
    const { make } = await store();
    const first = make();
    const second = make();
    await Promise.all([first.list(), second.list()]);
    await Promise.all([first.ensure("first", "/repo"), second.ensure("second", "/repo"), first.ensure("third", "/repo")]);
    expect((await make().list()).map((record) => record.tauThreadId).sort()).toEqual(["first", "second", "third"]);
  });

  it("preserves both hosts' threads when stores alternate writes to one file", async () => {
    const { make } = await store();
    const first = make();
    const second = make();
    await Promise.all([first.list(), second.list()]);
    await first.ensure("first", "/repo");
    await second.ensure("second", "/repo");
    await first.ensure("third", "/repo");
    await second.ensure("fourth", "/repo");
    expect((await make().list()).map((record) => record.tauThreadId).sort()).toEqual(["first", "fourth", "second", "third"]);
  });
});

describe("AcpSessionStore tallies", () => {
  it("answers what a thread was billed for, per model, and a new turn counts at once", async () => {
    const acp = (await store()).make();
    await acp.recordUsage("t", "/repo", total(1), turn(1));
    await acp.recordUsage("t", "/repo", total(2), turn(2, "m-2"));
    expect(acp.talliesOf("t")).toEqual([{ provider: "xai", model: "m-1", ...total(1) }, { provider: "xai", model: "m-2", ...total(1) }]);
    acp.talliesOf("t")[0]!.costUsd = 99;
    await acp.recordUsage("t", "/repo", total(3), turn(3));
    expect(acp.talliesOf("t")).toEqual([{ provider: "xai", model: "m-1", ...total(2) }, { provider: "xai", model: "m-2", ...total(1) }]);
    expect(acp.talliesOf("missing")).toEqual([]);
  });

  it("names a thread that kept only its total by its origin, and leaves one without usage out", async () => {
    const acp = (await store()).make();
    await acp.recordUsage("legacy", "/repo", total(3));
    await acp.setObservedModel("legacy", "/repo", "m-9");
    await acp.ensure("unused", "/repo");
    expect(acp.talliesOf("legacy", (record) => ({ provider: "xai", ...(record.observedModel ? { model: record.observedModel } : {}) }))).toEqual([{ provider: "xai", model: "m-9", ...total(3) }]);
    expect(acp.talliesOf("legacy")).toEqual([total(3)]);
    expect(acp.talliesOf("unused")).toEqual([]);
  });
});

describe("AcpSessionStore creation time", () => {
  it("keeps when a thread began across later changes", async () => {
    const acp = (await store()).make();
    await acp.ensure("t", "/repo");
    await acp.setObservedModel("t", "/repo", "m-1");
    expect((await acp.list()).map((record) => record.createdAt)).toEqual([7]);
  });
});

it("persists append-only messages and immutable usage in SQLite across disposal", async () => {
  const { make } = await store();
  const writer = make();
  await writer.appendMessages("thread", "/repo", [{ id: "user", role: "user", text: "hello", timestamp: 1, clientMessageId: "prompt" }]);
  const suppliedTurn = turn(1);
  await writer.recordUsage("thread", "/repo", total(1), suppliedTurn);
  suppliedTurn.costUsd = 99;
  await writer.setTitle("thread", "/repo", "Retained", "renamed");
  await writer.appendMessages("thread", "/repo", [{ id: "answer", role: "assistant", text: "answer", timestamp: 2 }]);
  await writer.dispose();
  expect((await readFile(writer.databasePath)).subarray(0, 16).toString()).toBe("SQLite format 3\0");
  const reader = make();
  const restored = await reader.get("thread");
  expect(restored?.messages.map((message) => message.text)).toEqual(["hello", "answer"]);
  expect(restored?.title).toBe("Retained");
  expect(restored?.usageTurns?.[0]?.costUsd).toBe(0.5);
});
