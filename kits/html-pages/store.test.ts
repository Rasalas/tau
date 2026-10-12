import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageStore } from "./store.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "tau-pages-store-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const meta = (title: string) => ({ title, maxHeight: 720, origins: [] as string[] });

describe("PageStore", () => {
  it("keeps a page per thread and reads it back", async () => {
    let clock = 1;
    const store = new PageStore({ directory, now: () => clock++ });
    const a = await store.add("t1", { meta: meta("A"), html: "<p>a</p>" });
    const b = await store.add("t2", { meta: meta("B"), html: "<p>b</p>" });
    expect(await store.get("t1", a)).toMatchObject({ html: "<p>a</p>", meta: { title: "A", createdAt: 1 } });
    expect(await store.get("t1", b)).toBeUndefined();
    expect((await store.list("t2")).map((page) => page.meta.title)).toEqual(["B"]);
  });

  it("answers nothing for ids that could climb out of the folder", async () => {
    const store = new PageStore({ directory });
    await store.add("t1", { meta: meta("A"), html: "x" });
    expect(await store.get("t1", "../t1/x")).toBeUndefined();
    expect(await store.get("../escape", "abcdefgh")).toBeUndefined();
    await store.add("../escape", { meta: meta("E"), html: "x" });
    expect(await readdir(directory)).toHaveLength(2);
  });

  it("drops the oldest pages past the count and size limits, never the new one", async () => {
    let clock = 1;
    const store = new PageStore({ directory, now: () => clock++, limits: { pagesPerThread: 2, bytesPerThread: 10 } });
    const first = await store.add("t", { meta: meta("1"), html: "aaaa" });
    const second = await store.add("t", { meta: meta("2"), html: "bbbb" });
    const third = await store.add("t", { meta: meta("3"), html: "cccc" });
    expect(await store.get("t", first)).toBeUndefined();
    expect((await store.list("t")).map((page) => page.id)).toEqual([third, second]);
    const big = await store.add("t", { meta: meta("4"), html: "d".repeat(50) });
    expect((await store.list("t")).map((page) => page.id)).toEqual([big]);
  });

  it("forgets a thread and ignores a page whose JSON was never written", async () => {
    const store = new PageStore({ directory });
    const id = await store.add("t", { meta: meta("A"), html: "x" });
    await rm(join(directory, "t", `${id}.json`));
    expect(await store.list("t")).toEqual([]);
    await store.add("t", { meta: meta("B"), html: "y" });
    await store.forgetThread("t");
    expect(await store.list("t")).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
});
