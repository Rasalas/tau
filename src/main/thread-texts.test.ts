import { describe, expect, it } from "vitest";
import { THREAD_TEXT_CHARS, threadTextsDelta } from "./thread-texts.js";

const record = (id: string, updatedAt: number, texts: Array<[string, string]> = [["user", `about ${id}`]]) => ({
  tauThreadId: id, updatedAt, messages: texts.map(([role, text]) => ({ role, text })),
});

describe("threadTextsDelta", () => {
  it("answers with the threads the caller lacks or holds older, newest first, and names the ones gone", () => {
    const records = [record("a", 10), record("b", 30), record("c", 20)];
    const answer = threadTextsDelta(records, { known: { a: 10, c: 5, gone: 1 } });
    expect(answer.threads.map((thread) => thread.threadId)).toEqual(["b", "c"]);
    expect(answer.removed).toEqual(["gone"]);
    expect(answer.more).toBe(false);
  });

  it("hands out at most `limit` threads and says more are waiting", () => {
    const records = Array.from({ length: 5 }, (_, index) => record(`t${index}`, index));
    const first = threadTextsDelta(records, { limit: 2 });
    expect(first.threads.map((thread) => thread.threadId)).toEqual(["t4", "t3"]);
    expect(first.more).toBe(true);
    const known = Object.fromEntries(first.threads.map((thread) => [thread.threadId, thread.updatedAt]));
    expect(threadTextsDelta(records, { known, limit: 2 }).threads.map((thread) => thread.threadId)).toEqual(["t2", "t1"]);
  });

  it("keeps only user and assistant text, and the start of a long thread", () => {
    const long = "x".repeat(THREAD_TEXT_CHARS - 9);
    const [thread] = threadTextsDelta([record("a", 1, [["user", "hi"], ["toolResult", "ignored"], ["assistant", "  "], ["assistant", long], ["user", "the end of it"]])], {}).threads;
    expect(thread!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(thread!.messages.at(-1)!.text).toBe("the end");
  });

  it("reads garbage input as an empty request", () => {
    expect(threadTextsDelta([record("a", 1)], "nonsense").threads).toHaveLength(1);
    expect(threadTextsDelta([record("a", 1)], { known: { a: "1" }, limit: -3 }).threads).toHaveLength(1);
  });
});

describe("versioned thread text exports", () => {
  it("pages the whole visible history with Unicode-safe offsets and explicit message ends", () => {
    const content = "a".repeat(63_999) + "𐐀😀 beacon " + "z".repeat(80_000);
    const records = [record("large", 7, [["toolResult", "hidden"], ["user", content], ["assistant", "reply"]])];
    const version = threadTextsDelta(records, { protocol: 2 }).catalog![0]!.version;
    const collected = new Map<string, string>();
    const ends: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = threadTextsDelta(records, { protocol: 2, maxChars: 64_000, page: { threadId: "large", version, cursor } }).page!;
      expect(page.status).toBe("ok");
      expect(page.version).toBe(version);
      expect(page.chunks.reduce((size, chunk) => size + chunk.text.length, 0)).toBeLessThanOrEqual(64_000);
      for (const chunk of page.chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(16_384);
        expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
        expect(chunk.offset).toBe((collected.get(chunk.messageId) ?? "").length);
        collected.set(chunk.messageId, (collected.get(chunk.messageId) ?? "") + chunk.text);
        if (chunk.end) ends.push(chunk.messageId);
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect([...collected.values()]).toEqual([content, "reply"]);
    expect(ends).toEqual(["1", "2"]);
    expect(pages).toBeGreaterThan(2);
    expect(threadTextsDelta(records, {}).threads[0]!.messages.reduce((sum, message) => sum + message.text.length, 0)).toBe(THREAD_TEXT_CHARS);
  });

  it("invalidates a cursor after a same-timestamp edit and binds it to its thread and version", () => {
    const records = [record("a", 1, [["user", "ab😀cd"]]), record("b", 1)];
    const version = threadTextsDelta(records, { protocol: 2 }).catalog!.find(entry => entry.threadId === "a")!.version;
    const first = threadTextsDelta(records, { protocol: 2, maxChars: 2, page: { threadId: "a", version } }).page!;
    expect(first.chunks).toEqual([{ messageId: "0", role: "user", offset: 0, text: "ab", end: false }]);
    expect(threadTextsDelta(records, { protocol: 2, page: { threadId: "a", version, cursor: JSON.stringify(["b", version, 0, 2]) } }).page!.status).toBe("invalid-cursor");
    expect(threadTextsDelta(records, { protocol: 2, page: { threadId: "a", version, cursor: JSON.stringify(["a", version, 0, 3]) } }).page!.status).toBe("invalid-cursor");
    records[0]!.messages[0]!.text = "changed";
    const changed = threadTextsDelta(records, { protocol: 2, knownVersions: { a: version } });
    expect(changed.catalog!.some(entry => entry.threadId === "a" && entry.version !== version)).toBe(true);
    expect(threadTextsDelta(records, { protocol: 2, page: { threadId: "a", version, cursor: first.nextCursor! } }).page).toMatchObject({ status: "changed", chunks: [] });
  });

  it("returns catalog versions and tombstones without text, even at a zero text budget", () => {
    const answer = threadTextsDelta([record("a", 1), record("b", 2)], {
      protocol: 2, limit: 1, maxChars: 0, known: { deletedAfterRestart: 1 }, knownVersions: { gone: "revision" },
    });
    expect(answer).toMatchObject({ protocol: 2, threads: [], catalog: [{ threadId: "b" }], more: true });
    expect(answer.removed.sort()).toEqual(["deletedAfterRestart", "gone"]);
    const version = threadTextsDelta([record("empty", 1, [])], { protocol: 2 }).catalog![0]!.version;
    expect(threadTextsDelta([record("empty", 1, [])], { protocol: 2, page: { threadId: "empty", version } }).page)
      .toMatchObject({ status: "ok", chunks: [], nextCursor: null });
    expect(threadTextsDelta([], { protocol: 2, page: { threadId: "empty", version } }).page)
      .toMatchObject({ status: "missing", chunks: [], nextCursor: null });
  });

  it("bounds object overhead for many tiny messages", () => {
    const records = [record("tiny", 1, Array.from({ length: 600 }, () => ["assistant", "a"] as [string, string]))];
    const version = threadTextsDelta(records, { protocol: 2 }).catalog![0]!.version;
    const page = threadTextsDelta(records, { protocol: 2, page: { threadId: "tiny", version } }).page!;
    expect(page.chunks).toHaveLength(256);
    expect(page.nextCursor).not.toBeNull();
  });
});
