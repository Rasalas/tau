import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiToolRun, UiTurnActivityEntry } from "../shared/contracts.js";
import { TurnActivityStore } from "./turn-activity-store.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "tau-activity-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const run = (id: string, status: UiToolRun["status"], extra: Partial<UiToolRun> = {}): UiToolRun => ({ id, name: "bash", args: { command: `echo ${id}` }, status, startedAt: 1, ...extra });
const turn = (id: string, status: UiTurnActivityEntry["status"], tools: UiToolRun[], anchor = "m1"): UiTurnActivityEntry => ({ id, anchorMessageId: anchor, status, tools });

describe("TurnActivityStore", () => {
  it("gives back each turn's cards, in order, after a restart", async () => {
    const store = new TurnActivityStore({ directory });
    expect(await store.load("t1")).toEqual([]);
    await store.save("t1", turn("activity-t1-1", "running", [run("a", "running")]));
    await store.save("t1", turn("activity-t1-1", "running", [run("a", "done", { output: "a", endedAt: 2 })]));
    await store.save("t1", turn("activity-t1-1", "completed", [run("a", "done", { output: "a", endedAt: 2 }), run("b", "error", { output: "no", endedAt: 3 })]));
    await store.save("t1", turn("activity-t1-2", "completed", [run("c", "done", { endedAt: 4 })], "m3"));

    const loaded = await new TurnActivityStore({ directory }).load("t1");
    expect(loaded.map((entry) => [entry.anchorMessageId, entry.status, entry.tools.map((tool) => `${tool.id}:${tool.status}:${tool.output ?? ""}`)])).toEqual([
      ["m1", "completed", ["a:done:a", "b:error:no"]],
      ["m3", "completed", ["c:done:"]],
    ]);
    expect(await new TurnActivityStore({ directory }).load("other")).toEqual([]);
  });

  it("appends only what changed", async () => {
    const store = new TurnActivityStore({ directory });
    await store.load("t1");
    const entry = turn("activity-t1-1", "running", [run("a", "done", { endedAt: 2 })]);
    await store.save("t1", entry);
    await store.save("t1", entry);
    await store.save("t1", { ...entry, status: "completed" });
    const lines = (await readFile(join(directory, "t1.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("reads a turn a restart cut short as interrupted, its running tools as failed", async () => {
    const store = new TurnActivityStore({ directory });
    await store.save("t1", turn("activity-t1-1", "running", [run("a", "done", { endedAt: 2 }), run("b", "running", { output: "half" }), run("c", "running")]));
    const [entry] = await new TurnActivityStore({ directory }).load("t1");
    expect(entry!.status).toBe("interrupted");
    expect(entry!.tools.map((tool) => [tool.status, tool.output])).toEqual([["done", undefined], ["error", "half"], ["error", "The turn ended before this tool finished."]]);
  });

  it("keeps the ids the host gave, so a client that saw a turn recognises it after a restart", async () => {
    const store = new TurnActivityStore({ directory });
    await store.load("t1");
    await store.save("t1", turn("activity-t1-1", "completed", [run("a", "done")]));
    const first = await new TurnActivityStore({ directory }).load("t1");
    expect(first.map((entry) => entry.id)).toEqual(["activity-t1-1"]);
    await store.save("t1", turn("activity-t1-2", "completed", [run("b", "done")]));
    const again = await new TurnActivityStore({ directory }).load("t1");
    expect(again.map((entry) => [entry.id, entry.tools.map((tool) => tool.id)])).toEqual([["activity-t1-1", ["a"]], ["activity-t1-2", ["b"]]]);
  });

  it("clips long output and arguments and drops turns beyond the limit", async () => {
    const store = new TurnActivityStore({ directory, maxTurns: 2, maxOutputChars: 10, maxArgumentChars: 5 });
    await store.load("t1");
    await store.save("t1", turn("activity-t1-1", "completed", [run("a", "done", { output: "0123456789abcdef", args: { command: "abcdefgh", nested: { big: "x".repeat(20) }, small: { n: 1 } } })]));
    await store.save("t1", turn("activity-t1-2", "completed", [run("b", "done")]));
    await store.save("t1", turn("activity-t1-3", "completed", [run("c", "done")]));
    const loaded = await new TurnActivityStore({ directory, maxTurns: 2 }).load("t1");
    expect(loaded.map((entry) => entry.tools[0]!.id)).toEqual(["b", "c"]);

    const small = new TurnActivityStore({ directory, maxOutputChars: 10, maxArgumentChars: 8 });
    await small.save("t3", turn("activity-t3-1", "completed", [run("a", "done", { output: "0123456789abcdef", args: { command: "abcdefghij", nested: { big: "x".repeat(20) }, small: { n: 1 } } })]));
    const [kept] = await small.load("t3");
    expect(kept!.tools[0]!.args).toEqual({ command: "abcdefgh…", small: { n: 1 } });
    expect(kept!.tools[0]!.output).toMatch(/6789abcdef$/u);
    expect(kept!.tools[0]!.output).toContain("not kept");
  });

  it("compacts a file that holds far more lines than its turns", async () => {
    const store = new TurnActivityStore({ directory });
    await store.load("t1");
    for (let index = 0; index < 60; index += 1) {
      await store.save("t1", turn("activity-t1-1", "running", [run("a", "running", { output: "x".repeat(index + 1) })]));
    }
    const before = (await readFile(join(directory, "t1.jsonl"), "utf8")).trim().split("\n").length;
    await new TurnActivityStore({ directory }).load("t1");
    const after = (await readFile(join(directory, "t1.jsonl"), "utf8")).trim().split("\n").length;
    expect(before).toBeGreaterThan(60);
    expect(after).toBe(2);
    expect((await new TurnActivityStore({ directory }).load("t1"))[0]!.tools[0]!.output).toBe("x".repeat(60));
  });

  it("takes a thread's file out for the trash and puts it back", async () => {
    const store = new TurnActivityStore({ directory });
    await store.save("t1", turn("activity-t1-1", "completed", [run("a", "done")]));
    const taken = await store.take("t1");
    expect(taken).toContain("\"a\"");
    expect(await readdir(directory)).toEqual([]);
    expect(await store.load("t1")).toEqual([]);
    await store.put("t1", taken);
    await store.put("t1", 42);
    expect((await store.load("t1")).map((entry) => entry.tools[0]!.id)).toEqual(["a"]);
    expect(await store.take("missing")).toBeUndefined();
  });

  it("names a thread id that is no file name by its hash", async () => {
    const store = new TurnActivityStore({ directory });
    await store.save("../evil", turn("activity-1", "completed", [run("a", "done")]));
    const [file] = await readdir(directory);
    expect(file).toMatch(/^[0-9a-f]{40}\.jsonl$/u);
    expect(await store.load("../evil")).toHaveLength(1);
  });
});

it("keeps tool images after restarting", async () => {
  const media = [{ type: "image" as const, url: "data:image/png;base64,AQ==" }];
  await new TurnActivityStore({ directory }).save("media", turn("turn", "completed", [run("image", "done", { media })]));
  expect((await new TurnActivityStore({ directory }).load("media"))[0]?.tools[0]?.media).toEqual(media);
});

it("persists native activity metadata and equal-length result updates, restoring detached agents as idle", async () => {
  const store = new TurnActivityStore({ directory });
  await store.load("parent");
  const agent = run("native", "running", { kind: "subagent", args: { agentId: "child", title: "Alpha", agentStatus: "running" }, output: "one" });
  await store.save("parent", turn("first", "completed", [agent]));
  await store.save("parent", turn("second", "completed", [run("ordinary", "done")]));
  await store.save("parent", turn("first", "completed", [{ ...agent, args: { ...agent.args, title: "Bravo" }, output: "two" }]));
  const restored = await new TurnActivityStore({ directory }).load("parent");
  expect(restored[0]?.tools[0]).toMatchObject({ kind: "subagent", status: "done", args: { title: "Bravo", agentStatus: "idle" }, output: "two" });
  expect(restored[1]?.tools[0]?.id).toBe("ordinary");
});
