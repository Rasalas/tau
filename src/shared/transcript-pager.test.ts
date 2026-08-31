import { describe, expect, it } from "vitest";
import { pageRecords, TranscriptPager } from "./transcript-pager.js";
import type { UiMessage } from "./contracts.js";

const messages: UiMessage[] = Array.from({ length: 12 }, (_, i) => ({
  id: String(i), role: i % 2 === 0 ? "user" : "assistant", text: String(i), timestamp: i,
}));

describe("TranscriptPager", () => {
  it("returns the newest bounded page and a cursor for older records", () => {
    const page = TranscriptPager.pageFor("thread", messages, 3);
    expect(page.sessionId).toBe("thread");
    expect(page.messages.length).toBeLessThanOrEqual(6);
    expect(page.hasMore).toBe(true);
    expect(page.olderCursor).toBeDefined();
  });

  it("rejects malformed cursors", () => {
    expect(() => new TranscriptPager(messages, 2).page("nope")).toThrow("Invalid transcript cursor");
  });

  it("uses the same cursor semantics for raw bridge records", () => {
    const records = messages.map((message) => ({ role: message.role, id: message.id }));
    const page = pageRecords(records, 3, undefined, (record) => record.role === "user");
    expect(page.messages.map((record) => record.id)).toEqual(["6", "7", "8", "9", "10", "11"]);
    expect(page.olderCursor).toBe("6");

    const beforeTail = pageRecords(records, 3, "6", (record) => record.role === "user");
    expect(beforeTail.messages.map((record) => record.id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(beforeTail.hasMore).toBe(false);
  });
});
