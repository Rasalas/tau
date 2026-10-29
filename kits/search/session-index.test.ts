import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionTexts, SESSION_LINE_BYTES, SESSION_READ_BYTES, SessionTextIndex } from "./session-index.js";
import { THREAD_TEXT_LIMIT } from "./threads.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const message = (content: string) => JSON.stringify({ type: "message", message: { role: "user", content } });
async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), "tau-search-index-")); roots.push(root);
  const path = join(root, "session.jsonl");
  await writeFile(path, content);
  const info = await stat(path);
  return { sessionId: root, path, size: info.size, mtimeMs: info.mtimeMs };
}

describe("bounded session text reads", () => {
  it("retains a prefix of a million-character message, with truncation disclosed", async () => {
    const file = await fixture(message("x".repeat(1_000_000) + "tailneedle"));
    const result = await readSessionTexts(file.path, file.size);
    expect(result.texts[0]!.text).toHaveLength(THREAD_TEXT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(file.size);
  });

  it("bounds file I/O even when a large tool-only session has no searchable messages", async () => {
    const file = await fixture((JSON.stringify({ type: "message", message: { role: "toolResult", content: "x".repeat(100_000) } }) + "\n").repeat(120) + message("tailneedle"));
    const result = await readSessionTexts(file.path, file.size);
    expect(result).toMatchObject({ texts: [], truncated: true, bytesRead: SESSION_READ_BYTES });
    expect(file.size).toBeGreaterThan(result.bytesRead);
  });

  it("skips an oversized JSONL record, keeps later messages, and discloses the gap", async () => {
    const file = await fixture(message("x".repeat(SESSION_LINE_BYTES + 1)) + "\n" + message("later needle"));
    expect(await readSessionTexts(file.path, file.size)).toMatchObject({ texts: [{ role: "user", text: "later needle" }], truncated: true });
  });

  it("preserves JSON whitespace, block text, unicode across chunks, and a final line without newline", async () => {
    const text = "a".repeat(65_480) + "🌙 needle";
    const file = await fixture(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: "hidden" }, { type: "text", text: "last" }] } }, null, 0).replace('"type":', '"type": ') );
    expect(await readSessionTexts(file.path, file.size)).toMatchObject({ texts: [{ role: "assistant", text: text + "\nlast" }], truncated: false });
  });

  it("stops between chunks when a query is cancelled", async () => {
    const file = await fixture(message("x".repeat(1_000_000)));
    let checks = 0;
    const result = await readSessionTexts(file.path, file.size, () => ++checks > 1);
    expect(result.bytesRead).toBe(64 * 1024);
    expect(result.truncated).toBe(true);
    // The descriptor was closed, so deletion also works on Windows.
    await rm(file.path);
  });
});

describe("session text cache", () => {
  it("shares concurrent reads and evicts by total text size; evicted files remain searchable", async () => {
    const a = await fixture(message("a".repeat(80)));
    const b = await fixture(message("b".repeat(80)));
    const index = new SessionTextIndex({ list: async () => [a, b], now: () => 0, budgetChars: 100 });
    const reads = await Promise.all([index.texts(a), index.texts(a)]);
    expect(reads.map((read) => read.bytesRead)).toEqual([a.size, 0]);
    expect(index.size).toBe(80);
    await index.texts(b);
    expect(index.size).toBe(80);
    expect((await index.texts(a)).bytesRead).toBe(a.size);
    expect(index.size).toBeLessThanOrEqual(100);
  });

  it("does not cache failures or cancelled reads, and rereads changed files", async () => {
    const a = await fixture(message("before"));
    const index = new SessionTextIndex({ list: async () => [a], now: () => 0 });
    expect(await index.texts(a, () => true)).toMatchObject({ truncated: true });
    expect(index.size).toBe(0);
    await rm(a.path);
    expect(await index.texts(a)).toMatchObject({ truncated: true, error: expect.any(String) });
    await writeFile(a.path, message("after the change"));
    const changed = { ...a, ...await stat(a.path) };
    expect((await index.texts(changed)).texts[0]!.text).toBe("after the change");
    expect(index.size).toBe(16);
    index.invalidate();
    expect(index.size).toBe(0);
  });

  it("reuses metadata briefly and refreshes on TTL, explicit invalidation, and deletion", async () => {
    const a = await fixture(message("needle"));
    let clock = 0;
    const list = vi.fn(async () => [a]);
    const index = new SessionTextIndex({ list, now: () => clock });
    await Promise.all([index.sessions(), index.sessions()]);
    expect(list).toHaveBeenCalledTimes(1);
    await index.texts(a);
    clock = 5_000;
    await index.sessions();
    expect(list).toHaveBeenCalledTimes(2);
    list.mockResolvedValue([]);
    index.invalidate();
    expect(await index.sessions()).toMatchObject({ entries: [] });
    expect(index.size).toBe(0);
  });
});

it("does not republish metadata invalidated during an in-flight refresh", async () => {
  const a = await fixture(message("needle"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const list = vi.fn().mockImplementationOnce(async () => { await gate; return [a]; }).mockResolvedValue([]);
  const index = new SessionTextIndex({ list, now: () => 0 });
  const first = index.sessions();
  index.invalidate();
  const second = index.sessions();
  expect(list).toHaveBeenCalledOnce();
  release();
  expect(await first).toMatchObject({ entries: [] });
  expect(await second).toMatchObject({ entries: [] });
  expect(list).toHaveBeenCalledTimes(2);
});
