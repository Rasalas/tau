import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assistantLine, DAY, writeSession } from "./fixtures.js";
import { appendFile } from "node:fs/promises";
import { decodeSession, encodeSession, PiUsageCache, readPiSessionUsage } from "./pi-sessions.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-usage-pi-"));
  directories.push(directory);
  return directory;
}

const T0 = Date.UTC(2026, 8, 1, 12);

describe("reading a Pi session file", () => {
  it("counts assistant responses, tool results and compactions, and skips what does not parse", async () => {
    const sessions = await temporary();
    const path = await writeSession(sessions, {
      id: "s1",
      cwd: "/work/alpha",
      createdAt: T0,
      lines: [
        JSON.stringify({ type: "model_change", id: "m1", provider: "anthropic", modelId: "claude-haiku-4-5" }),
        JSON.stringify({ type: "message", id: "u1", timestamp: new Date(T0).toISOString(), message: { role: "user", content: "the word \"usage\" in a prompt" } }),
        assistantLine({ id: "a1", at: T0 + 1_000, input: 1_000, output: 50, cacheRead: 200, cost: 0.02 }),
        JSON.stringify({ type: "message", id: "t1", timestamp: new Date(T0 + 2_000).toISOString(), message: { role: "toolResult", usage: { input: 7, output: 0, totalTokens: 7 } } }),
        assistantLine({ id: "a2", at: T0 + 3_000, provider: "openai", model: "gpt-5.6-luna", input: 300, output: 30, cost: 0 }),
        JSON.stringify({ type: "compaction", id: "c1", timestamp: new Date(T0 + 4_000).toISOString(), usage: { input: 500, output: 40, totalTokens: 540, cost: { total: 0.005 } } }),
        "{\"usage\": broken",
      ],
    });
    const info = await stat(path);
    const read = await readPiSessionUsage(path, { size: info.size, mtimeMs: info.mtimeMs });

    expect(read).toMatchObject({ sessionId: "s1", cwd: "/work/alpha", createdAt: T0, skippedLines: 1 });
    // Summed per quarter hour and model: a1 and the tool result t1 on Haiku; a2 and the compaction c1,
    // which runs on the thread's model, the last one that answered.
    expect(read.buckets.map((bucket) => [bucket.at, bucket.model, bucket.requests, bucket.total, bucket.cost])).toEqual([
      [T0, "anthropic/claude-haiku-4-5", 1, 1_257, 0.02],
      [T0, "openai/gpt-5.6-luna", 2, 870, 0.005],
    ]);
    expect(read.keys).toHaveLength(4);
  });

  it("survives the cache's own encoding", async () => {
    const sessions = await temporary();
    const path = await writeSession(sessions, { id: "s1", cwd: "/work/alpha", createdAt: T0, lines: [assistantLine({ id: "a1", at: T0 })] });
    const info = await stat(path);
    const read = await readPiSessionUsage(path, { size: info.size, mtimeMs: info.mtimeMs });
    expect(decodeSession(JSON.parse(JSON.stringify(encodeSession(read))))).toEqual(read);
    expect(decodeSession({ path: 1 })).toBeUndefined();
  });
});

describe("the session cache", () => {
  it("reads a file once, until its size or mtime changes, and remembers across instances", async () => {
    const root = await temporary();
    const sessions = join(root, "sessions");
    const cacheFile = join(root, "state", "pi-usage.json");
    const path = await writeSession(sessions, { id: "s1", cwd: "/work/alpha", createdAt: T0, lines: [assistantLine({ id: "a1", at: T0, input: 100 })] });
    // Whole seconds, so setting the same mtime again reproduces it exactly.
    const stamp = new Date(T0);
    await utimes(path, stamp, stamp);

    const first = await new PiUsageCache(cacheFile).scan(sessions);
    expect(first.found).toBe(true);
    expect(first.sessions[0]?.buckets[0]?.input).toBe(100);

    // Same size and mtime: a new instance answers from the cache file without reading the session.
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("\"input\":100", "\"input\":999"));
    await utimes(path, stamp, stamp);
    const cached = await new PiUsageCache(cacheFile).scan(sessions);
    expect(cached.sessions[0]?.buckets[0]?.input).toBe(100);

    // A changed stamp is read again.
    await utimes(path, stamp, new Date(T0 + 5_000));
    const fresh = await new PiUsageCache(cacheFile).scan(sessions);
    expect(fresh.sessions[0]?.buckets[0]?.input).toBe(999);
  });

  it("forgets a deleted session, and reports a missing directory as not found", async () => {
    const root = await temporary();
    const sessions = join(root, "sessions");
    const cache = new PiUsageCache();
    const path = await writeSession(sessions, { id: "s1", cwd: "/work/alpha", createdAt: T0, lines: [assistantLine({ id: "a1", at: T0 + DAY })] });
    expect((await cache.scan(sessions)).sessions).toHaveLength(1);
    await unlink(path);
    expect((await cache.scan(sessions)).sessions).toEqual([]);
    expect(await cache.scan(join(root, "nowhere"))).toEqual({ found: false, sessions: [], failed: 0 });
  });

  it("counts a response a fork copied once, for the file it was written to first", async () => {
    const root = await temporary();
    const sessions = join(root, "sessions");
    const shared = [assistantLine({ id: "a1", at: T0, input: 100 }), assistantLine({ id: "a2", at: T0 + DAY, input: 100 })];
    // Pi names a file by its time: the original sorts before its fork.
    await writeSession(sessions, { id: "2026-09-01T12-00-00-000Z_original", cwd: "/work/alpha", createdAt: T0, lines: shared });
    await writeSession(sessions, { id: "2026-09-03T12-00-00-000Z_fork", cwd: "/work/alpha", createdAt: T0 + 2 * DAY, lines: [...shared, assistantLine({ id: "f1", at: T0 + 2 * DAY, input: 5 })] });
    const scan = await new PiUsageCache().scan(sessions);
    const inputs = Object.fromEntries(scan.sessions.map((session) => [session.sessionId, session.buckets.reduce((sum, bucket) => sum + bucket.input, 0)]));
    expect(inputs).toEqual({ "2026-09-01T12-00-00-000Z_original": 200, "2026-09-03T12-00-00-000Z_fork": 5 });
  });

  it("reads a session that grew from where the last read stopped", async () => {
    const root = await temporary();
    const sessions = join(root, "sessions");
    const cacheFile = join(root, "state", "pi-usage.json");
    const opening = JSON.stringify({ type: "message", id: "u0", message: { role: "user", content: "x".repeat(1500) } });
    const path = await writeSession(sessions, { id: "s1", cwd: "/work/alpha", createdAt: T0, lines: [opening, assistantLine({ id: "a1", at: T0, input: 100 })] });
    await new PiUsageCache(cacheFile).scan(sessions);
    // Same length, other figures, before the offset: a read from the offset never sees it.
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("\"input\":100", "\"input\":900"));
    await appendFile(path, `${assistantLine({ id: "a2", at: T0 + 1_000, input: 7 })}\n`);
    const scan = await new PiUsageCache(cacheFile).scan(sessions);
    expect(scan.sessions[0]?.buckets.reduce((sum, bucket) => sum + bucket.input, 0)).toBe(107);
    expect(scan.sessions[0]?.sessionId).toBe("s1");
  });
});
