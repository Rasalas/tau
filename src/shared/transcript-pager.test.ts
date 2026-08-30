import { describe, expect, it } from "vitest";
import { TranscriptPager } from "./transcript-pager.js";
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
});
