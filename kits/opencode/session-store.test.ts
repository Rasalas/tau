import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeSessionStore } from "./session-store.js";

const directories: string[] = [];
const stores: OpenCodeSessionStore[] = [];
function tracked<T extends OpenCodeSessionStore>(liveStore: T): T { stores.push(liveStore); return liveStore; }
afterEach(async () => {
  const closed = await Promise.allSettled(stores.splice(0).map((liveStore) => liveStore.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const result of closed) if (result.status === "rejected") throw result.reason;
});

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "tau-opencode-store-"));
  directories.push(directory);
  const filePath = join(directory, "sessions.json");
  return { filePath, make: () => tracked(new OpenCodeSessionStore({ filePath, now: () => 5 })) };
}

describe("OpenCodeSessionStore shared database", () => {
  it("keeps other stores' model catalogs across thread and catalog writes", async () => {
    const { make } = await store();
    const first = make();
    const second = make();
    const model = (id: string) => ({ provider: "fake", id, name: id, variants: [] });
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

it("persists messages, model choices and catalogs in SQLite across disposal", async () => {
  const { make } = await store();
  const writer = make();
  await writer.appendMessages("thread", "/repo", [{ id: "user", role: "user", text: "hello", timestamp: 1, clientMessageId: "prompt" }]);
  await writer.setSelection("thread", "/repo", { model: { provider: "fake", id: "model" }, variant: "high" });
  await writer.setModels([{ provider: "fake", id: "model", name: "Model", variants: ["high"] }]);
  await writer.appendMessages("thread", "/repo", [{ id: "answer", role: "assistant", text: "answer", timestamp: 2 }]);
  await writer.dispose();
  expect((await readFile(writer.databasePath)).subarray(0, 16).toString()).toBe("SQLite format 3\0");
  const reader = make();
  const restored = await reader.get("thread");
  expect(restored?.messages.map((message) => message.text)).toEqual(["hello", "answer"]);
  expect(restored).toMatchObject({ model: { provider: "fake", id: "model" }, variant: "high" });
  expect(await reader.listModels()).toEqual([{ provider: "fake", id: "model", name: "Model", variants: ["high"] }]);
});
