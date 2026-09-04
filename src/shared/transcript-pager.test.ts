import { describe, expect, it } from "vitest";
import {
  countUserTurns,
  INITIAL_TRANSCRIPT_TURN_LIMIT,
  OLDER_TRANSCRIPT_TURN_LIMIT,
  pageRecords,
  transcriptPageBounds,
  TranscriptPager,
  type TranscriptCursorPolicy,
} from "./transcript-pager.js";
import type { UiMessage } from "./contracts.js";

const messages: UiMessage[] = Array.from({ length: 12 }, (_, i) => ({
  id: String(i), role: i % 2 === 0 ? "user" : "assistant", text: String(i), timestamp: i,
}));

const numericCursorPolicy: TranscriptCursorPolicy<string> = {
  cursorAtIndex: (index) => String(index),
  indexFromCursor: (cursor, maximum) => {
    if (!/^\d+$/u.test(cursor) || Number(cursor) > maximum) throw new Error("Invalid transcript cursor");
    return Number(cursor);
  },
};

describe("TranscriptPager", () => {
  it("returns the newest bounded page and a cursor for older records", () => {
    const page = TranscriptPager.pageFor("thread", messages, 3, undefined, numericCursorPolicy);
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

    const newest = new TranscriptPager(longHistory, INITIAL_TRANSCRIPT_TURN_LIMIT, numericCursorPolicy).page();
    expect(countUserTurns(newest.messages)).toBe(INITIAL_TRANSCRIPT_TURN_LIMIT);
    expect(newest.messages).toContainEqual(expect.objectContaining({ id: "user-34" }));
    expect(newest.messages).toContainEqual(expect.objectContaining({ id: "assistant-25" }));

    const older = new TranscriptPager(longHistory, OLDER_TRANSCRIPT_TURN_LIMIT, numericCursorPolicy).page(newest.olderCursor);
    expect(countUserTurns(older.messages)).toBe(OLDER_TRANSCRIPT_TURN_LIMIT);
    expect(older.messages.at(-1)?.id).toBe("notice-24");
    expect(newest.messages.some((message) => older.messages.some((candidate) => candidate.id === message.id))).toBe(false);
  });

  it("can walk every page exactly once", () => {
    const history: UiMessage[] = Array.from({ length: 47 }, (_, turn) => [
      { id: `u-${turn}`, role: "user" as const, text: `turn ${turn}`, timestamp: turn * 2 },
      { id: `a-${turn}`, role: "assistant" as const, text: "ok", timestamp: turn * 2 + 1 },
    ]).flat();
    const pager = new TranscriptPager(history, INITIAL_TRANSCRIPT_TURN_LIMIT, numericCursorPolicy);
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
    expect(() => new TranscriptPager(messages, 2, numericCursorPolicy).page("nope")).toThrow("Invalid transcript cursor");
    expect(() => new TranscriptPager(messages, 2, numericCursorPolicy).page("2x")).toThrow("Invalid transcript cursor");
  });

  it("shares the same user-boundary policy with Pi records that include tool roles", () => {
    const rawRecords = Array.from({ length: 14 }, () => [
      { role: "user" },
      { role: "assistant" },
      { role: "toolResult" },
    ]).flat();
    const bounds = transcriptPageBounds(rawRecords, 4);
    expect(rawRecords.slice(bounds.start, bounds.end).filter((record) => record.role === "user")).toHaveLength(4);
    expect(rawRecords[bounds.start]?.role).toBe("user");
    expect(bounds.hasMore).toBe(true);
  });

  it("preserves an adapter cursor through the shared policy", () => {
    const adapterPolicy: TranscriptCursorPolicy<string> = {
      cursorAtIndex: (index) => `adapter:${index}`,
      indexFromCursor: (cursor, maximum) => {
        const value = cursor.startsWith("adapter:") ? cursor.slice("adapter:".length) : "invalid";
        if (!/^\d+$/u.test(value) || Number(value) > maximum) throw new Error("Invalid transcript cursor");
        return Number(value);
      },
    };
    const bounds = transcriptPageBounds(messages, 3, "adapter:8", adapterPolicy);
    expect(bounds.olderCursor).toMatch(/^adapter:/u);
  });

  it("does not turn leading orphan activities into a partial older page", () => {
    const records: UiMessage[] = [
      { id: "orphan-assistant", role: "assistant", text: "orphan", timestamp: 0 },
      { id: "orphan-notice", role: "notice", text: "orphan activity", timestamp: 1 },
      { id: "user-0", role: "user", text: "first", timestamp: 2 },
      { id: "assistant-0", role: "assistant", text: "answer", timestamp: 3 },
    ];
    const page = TranscriptPager.pageFor("thread", records, 10, undefined, numericCursorPolicy);
    expect(page.messages.map((message) => message.id)).toEqual(["user-0", "assistant-0"]);
    expect(page.hasMore).toBe(false);
    expect(page.olderCursor).toBeUndefined();
  });

  it("treats an activity-only branch as a bounded empty transcript", () => {
    const records: UiMessage[] = [
      { id: "activity-0", role: "notice", text: "tool activity", timestamp: 0 },
      { id: "activity-1", role: "assistant", text: "non-user record", timestamp: 1 },
    ];
    const page = TranscriptPager.pageFor("thread", records, 10, undefined, numericCursorPolicy);
    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.olderCursor).toBeUndefined();
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
