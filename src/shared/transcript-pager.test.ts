import { describe, expect, it } from "vitest";
import { countUserTurns, INITIAL_TRANSCRIPT_TURN_LIMIT, OLDER_TRANSCRIPT_TURN_LIMIT, transcriptPageBounds, TranscriptPager } from "./transcript-pager.js";
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

  it("pages complete user turns, including differently sized adjacent records", () => {
    const longHistory: UiMessage[] = Array.from({ length: 35 }, (_, turn) => [
      { id: `user-${turn}`, role: "user" as const, text: `${turn}\n${"request ".repeat((turn % 5) + 1)}`, timestamp: turn * 3 },
      { id: `assistant-${turn}`, role: "assistant" as const, text: "answer ".repeat((turn % 7) + 1), timestamp: turn * 3 + 1 },
      ...(turn % 3 === 0 ? [{ id: `notice-${turn}`, role: "notice" as const, text: "activity", timestamp: turn * 3 + 2 }] : []),
    ]).flat();

    const newest = new TranscriptPager(longHistory).page();
    expect(countUserTurns(newest.messages)).toBe(INITIAL_TRANSCRIPT_TURN_LIMIT);
    expect(newest.messages).toContainEqual(expect.objectContaining({ id: "user-34" }));
    expect(newest.messages).toContainEqual(expect.objectContaining({ id: "assistant-25" }));

    const older = new TranscriptPager(longHistory, OLDER_TRANSCRIPT_TURN_LIMIT).page(newest.olderCursor);
    expect(countUserTurns(older.messages)).toBe(OLDER_TRANSCRIPT_TURN_LIMIT);
    expect(older.messages.at(-1)?.id).toBe("notice-24");
    expect(newest.messages.some((message) => older.messages.some((candidate) => candidate.id === message.id))).toBe(false);
  });

  it("can walk every page exactly once", () => {
    const history: UiMessage[] = Array.from({ length: 47 }, (_, turn) => [
      { id: `u-${turn}`, role: "user" as const, text: `turn ${turn}`, timestamp: turn * 2 },
      { id: `a-${turn}`, role: "assistant" as const, text: "ok", timestamp: turn * 2 + 1 },
    ]).flat();
    const pager = new TranscriptPager(history);
    const loaded: UiMessage[] = [];
    let page = pager.page();
    loaded.push(...page.messages);
    while (page.olderCursor) {
      page = pager.page(page.olderCursor);
      loaded.unshift(...page.messages);
    }
    expect(loaded.map((message) => message.id)).toEqual(history.map((message) => message.id));
  });

  it("rejects malformed cursors", () => {
    expect(() => new TranscriptPager(messages, 2).page("nope")).toThrow("Invalid transcript cursor");
    expect(() => new TranscriptPager(messages, 2).page("2x")).toThrow("Invalid transcript cursor");
  });

  it("shares the same user-boundary policy with Pi records that include tool roles", () => {
    const rawRecords = Array.from({ length: 14 }, (_, index) => [
      { role: "user" },
      { role: "assistant" },
      { role: "toolResult" },
    ]).flat();
    const bounds = transcriptPageBounds(rawRecords, 4);
    expect(rawRecords.slice(bounds.start, bounds.end).filter((record) => record.role === "user")).toHaveLength(4);
    expect(rawRecords[bounds.start]?.role).toBe("user");
    expect(bounds.hasMore).toBe(true);
  });
});
