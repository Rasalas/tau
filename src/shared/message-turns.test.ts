import { describe, expect, it } from "vitest";
import type { UiMessage } from "./contracts.js";
import { lastTurnNumber, numberWindowTurns, parseAsyncActivity, startsTurn, turnNumberOf, wakeMessageText } from "./message-turns.js";
import { TranscriptPager } from "./transcript-pager.js";

const say = (id: string, role: UiMessage["role"], text = id): UiMessage => ({ id, role, text, timestamp: 0 });
const policy = {
  cursorAtIndex: (index: number) => String(index),
  indexFromCursor: (cursor: string) => Number(cursor),
};

/** Twelve prompts, each answered; the sixth is followed by a note Tau sent in the user's name. */
const history: UiMessage[] = Array.from({ length: 12 }, (_, turn) => [
  say(`u${turn + 1}`, "user"),
  say(`a${turn + 1}`, "assistant"),
  ...(turn === 5 ? [say("note", "user", "[Tau] A thread you started has finished.")] : []),
]).flat();

describe("turn numbers of a window that leaves older turns out", () => {
  it("does not count a note sent in the user's name as a turn", () => {
    expect(startsTurn(say("note", "user", "[Tau] done"))).toBe(false);
    expect(lastTurnNumber(history)).toBe(12);
  });

  it("numbers the first prompt of the window, so the thread still says which turn it is on", () => {
    const page = TranscriptPager.pageFor("s", history, 4, undefined, policy);
    expect(page.hasMore).toBe(true);
    const prompts = page.messages.filter(startsTurn);
    expect(prompts.map((message) => message.id)).toEqual(["u9", "u10", "u11", "u12"]);
    expect(prompts[0]!.turnNumber).toBe(9);
    expect(prompts.slice(1).every((message) => message.turnNumber === undefined)).toBe(true);
    // Without the numbers the window would say turn 4.
    expect(lastTurnNumber(page.messages)).toBe(12);
    let number = 0;
    expect(prompts.map((message) => (number = turnNumberOf(number, message)))).toEqual([9, 10, 11, 12]);
  });

  it("numbers an older page the same way, and leaves a window that starts the thread alone", () => {
    const newest = TranscriptPager.pageFor("s", history, 4, undefined, policy);
    const older = TranscriptPager.pageFor("s", history, 4, newest.olderCursor, policy);
    expect(older.messages.find(startsTurn)).toMatchObject({ id: "u6", turnNumber: 6 });
    expect(lastTurnNumber([...older.messages, ...newest.messages])).toBe(12);
    expect(numberWindowTurns(history, 0, history.length)).toEqual(history);
    expect(history.every((message) => message.turnNumber === undefined)).toBe(true);
  });
});

describe("wake lines", () => {
  it("parses a wake as a quiet line that starts no turn", () => {
    const text = wakeMessageText({ source: "pull-request", label: "Woken by PR #42 · check smoke failed" }, "Check smoke failed on abc123.");
    expect(parseAsyncActivity(text)).toEqual({
      label: "Woken by PR #42 · check smoke failed",
      detail: "Check smoke failed on abc123.",
      wake: { source: "pull-request", label: "Woken by PR #42 · check smoke failed" },
    });
    expect(startsTurn({ id: "u", role: "user", text, timestamp: 1 })).toBe(false);
    expect(parseAsyncActivity(wakeMessageText({ source: "goal", label: "Goal continued · turn 3" }, ""))?.wake?.source).toBe("goal");
  });

  it("does not take a user's look-alike text with an unknown shape for a wake", () => {
    expect(parseAsyncActivity("[Tau wake: Bad Source] hi")).toBeUndefined();
    expect(wakeMessageText({ source: "Not valid!", label: "x" }, "")).toBe("[Tau wake: tau] x");
  });
});
