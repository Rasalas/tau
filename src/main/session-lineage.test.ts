import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePersistedJson } from "./persisted-json.js";
import {
  ORIGIN_ENTRY,
  PARENT_LINK_ENTRY,
  SessionLineageIndex,
  originEntry,
  parentLinkEntry,
  parentThreadIdFromEntries,
  readSessionLineage,
  readSessionParent,
} from "./session-lineage.js";
import { readSessionFileStamp } from "./session-usage.js";

const header = (id: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-06T10:00:00.000Z", cwd: "/project" });

const parentEntry = (parentThreadId: string) =>
  JSON.stringify({ type: "custom", customType: PARENT_LINK_ENTRY, id: "e1", parentId: null, timestamp: "2026-09-06T10:00:01.000Z", data: parentLinkEntry(parentThreadId, { depth: 1 }) });

const originLine = (hostId: string, threadId: string) =>
  JSON.stringify({ type: "custom", customType: ORIGIN_ENTRY, id: "o1", parentId: null, timestamp: "2026-09-06T10:00:00.500Z", data: originEntry({ hostId, threadId }) });

const message = (id: string, text: string) =>
  JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-09-06T10:00:02.000Z", message: { role: "user", content: [{ type: "text", text }] } });

let directory: string;

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "tau-lineage-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function session(name: string, lines: string[]): Promise<string> {
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

async function stamped(path: string) {
  return { path, stamp: (await readSessionFileStamp(path))! };
}

describe("a spawned thread's own session file", () => {
  it("names its parent on the line after the header", async () => {
    const path = await session("child", [header("child"), parentEntry("parent"), message("m1", "work")]);
    await expect(readSessionParent(path)).resolves.toBe("parent");
  });

  it("says nothing for a thread the user started", async () => {
    const path = await session("plain", [header("plain"), message("m1", "hello"), message("m2", "more")]);
    await expect(readSessionParent(path)).resolves.toBeUndefined();
  });

  it("finds a link an older build wrote deeper in the file only when asked to read on", async () => {
    const path = await session("legacy", [header("legacy"), message("m1", "work"), parentEntry("parent")]);
    await expect(readSessionParent(path)).resolves.toBeUndefined();
    await expect(readSessionParent(path, { deep: true })).resolves.toBe("parent");
  });

  it("reads the same link out of entries the host already holds", () => {
    expect(parentThreadIdFromEntries([
      { type: "message", id: "m1" },
      { type: "custom", customType: PARENT_LINK_ENTRY, data: parentLinkEntry("parent") },
    ])).toBe("parent");
    expect(parentThreadIdFromEntries([{ type: "custom", customType: "other", data: { parentThreadId: "parent" } }])).toBeUndefined();
  });

  it("is not confused by an unreadable or truncated file", async () => {
    await expect(readSessionParent(join(directory, "missing.jsonl"))).resolves.toBeUndefined();
    const path = await session("broken", [header("broken"), "{not json"]);
    await expect(readSessionParent(path)).resolves.toBeUndefined();
  });
});

describe("an imported thread's own session file", () => {
  it("names the machine it came from on the line after the header", async () => {
    const path = await session("imported", [header("imported"), originLine("host-a", "thread-a"), message("m1", "work")]);
    await expect(readSessionLineage(path)).resolves.toEqual({ origin: { hostId: "host-a", threadId: "thread-a" } });
  });

  it("still finds a parent link right after the origin", async () => {
    const path = await session("both", [header("both"), originLine("host-a", "thread-a"), parentEntry("parent"), message("m1", "work")]);
    await expect(readSessionLineage(path)).resolves.toEqual({ parentThreadId: "parent", origin: { hostId: "host-a", threadId: "thread-a" } });
  });

  it("is cached with the file, and survives a reload of the cache", async () => {
    const cachePath = join(directory, "session-lineage.json");
    const path = await session("imported", [header("imported"), originLine("host-a", "thread-a"), message("m1", "work")]);
    const first = new SessionLineageIndex({ path: cachePath });
    await first.load();
    await expect(first.resolve([await stamped(path)])).resolves.toEqual(new Map());
    expect(first.originOf(path)).toEqual({ hostId: "host-a", threadId: "thread-a" });
    await first.dispose();

    // A known origin never changes: the next run answers from the cache alone.
    await writeFile(path, `${header("imported")}\n`);
    const second = new SessionLineageIndex({ path: cachePath });
    await second.load();
    await second.resolve([await stamped(path)]);
    expect(second.originOf(path)).toEqual({ hostId: "host-a", threadId: "thread-a" });
  });
});

describe("the lineage cache", () => {
  it("answers a second pass without reading the file again, and re-reads when the stamp moved", async () => {
    const path = await session("thread", [header("thread"), message("m1", "hello")]);
    const stamp = { size: 10, mtimeMs: 100 };
    const index = new SessionLineageIndex();
    await expect(index.resolve([{ path, stamp }])).resolves.toEqual(new Map());

    // The file changed under the same stamp: the cached answer stands.
    await writeFile(path, `${[header("thread"), parentEntry("parent")].join("\n")}\n`);
    await expect(index.resolve([{ path, stamp }])).resolves.toEqual(new Map());
    await expect(index.resolve([{ path, stamp: { size: 20, mtimeMs: 200 } }])).resolves.toEqual(new Map([[path, "parent"]]));
    // A known parent never changes, so a later stamp costs no read at all.
    await writeFile(path, `${header("thread")}\n`);
    await expect(index.resolve([{ path, stamp: { size: 30, mtimeMs: 300 } }])).resolves.toEqual(new Map([[path, "parent"]]));
  });

  it("reads whole files once when no cache of this version exists, and only two lines after that", async () => {
    const cachePath = join(directory, "session-lineage.json");
    const legacy = await session("legacy", [header("legacy"), message("m1", "work"), parentEntry("parent")]);

    const first = new SessionLineageIndex({ path: cachePath });
    await first.load();
    expect(first.isMigrating).toBe(true);
    await expect(first.resolve([await stamped(legacy)])).resolves.toEqual(new Map([[legacy, "parent"]]));
    expect(first.isMigrating).toBe(false);
    await first.dispose();

    // The next run trusts the cache, so a link buried in a file it has never
    // seen is no longer looked for.
    const other = await session("other", [header("other"), message("m1", "work"), parentEntry("parent")]);
    const second = new SessionLineageIndex({ path: cachePath });
    await second.load();
    expect(second.isMigrating).toBe(false);
    const parents = await second.resolve([await stamped(legacy), await stamped(other)]);
    expect(parents).toEqual(new Map([[legacy, "parent"]]));
  });

  it("reads whole files again when the cache was written by another version", async () => {
    const cachePath = join(directory, "session-lineage.json");
    const legacy = await session("legacy", [header("legacy"), message("m1", "work"), parentEntry("parent")]);
    await writePersistedJson(cachePath, 99, { entries: [] });

    const index = new SessionLineageIndex({ path: cachePath });
    await index.load();
    expect(index.isMigrating).toBe(true);
    await expect(index.resolve([await stamped(legacy)])).resolves.toEqual(new Map([[legacy, "parent"]]));
  });

  it("forgets a session the index no longer lists", async () => {
    const path = await session("child", [header("child"), parentEntry("parent")]);
    const index = new SessionLineageIndex();
    await expect(index.resolve([await stamped(path)])).resolves.toEqual(new Map([[path, "parent"]]));
    index.retain([]);
    await rm(path, { force: true });
    await expect(index.resolve([{ path }])).resolves.toEqual(new Map());
  });

  it("keeps a link the host recorded before the child's file exists", async () => {
    const path = join(directory, "child.jsonl");
    const index = new SessionLineageIndex();
    index.record(path, undefined, "parent");
    await expect(index.resolve([{ path }])).resolves.toEqual(new Map([[path, "parent"]]));
  });
});
