import { describe, expect, it } from "vitest";
import { coldAfterMs, formatContextTokens, offerDueAt, offersResumeCompaction, readList } from "./rule.js";

const HOUR = 60 * 60_000;
const context = (tokens: number, updatedAt?: number, promptCacheTtlMs: number | null = HOUR) => ({
  tokens, contextWindow: 200_000, percent: tokens / 2_000,
  ...(updatedAt !== undefined ? { updatedAt } : {}),
  ...(promptCacheTtlMs !== null ? { promptCacheTtlMs } : {}),
});

describe("the resume compaction rule", () => {
  const at = 1_000_000_000;

  it("offers from 100k tokens and 70 minutes on, not a token or a millisecond before", () => {
    expect(offersResumeCompaction(context(100_000, at), at + coldAfterMs(HOUR))).toBe(true);
    expect(offersResumeCompaction(context(99_999, at), at + coldAfterMs(HOUR))).toBe(false);
    expect(offersResumeCompaction(context(153_000, at), at + coldAfterMs(HOUR) - 1)).toBe(false);
    expect(offersResumeCompaction(context(153_000, at), at + 5 * HOUR)).toBe(true);
  });

  it("follows the cache the runtime names, with a small margin", () => {
    const FIVE = 5 * 60_000;
    expect(coldAfterMs(HOUR)).toBe(70 * 60_000);
    expect(coldAfterMs(FIVE)).toBe(FIVE + 60_000);
    expect(offersResumeCompaction(context(153_000, at, FIVE), at + coldAfterMs(FIVE) - 1)).toBe(false);
    expect(offersResumeCompaction(context(153_000, at, FIVE), at + coldAfterMs(FIVE))).toBe(true);
    expect(offerDueAt(context(153_000, at, FIVE))).toBe(at + coldAfterMs(FIVE));
  });

  it("leaves out a runtime that names no prompt cache or does not date its context", () => {
    expect(offersResumeCompaction(context(153_000, at, null), at + 2 * HOUR)).toBe(false);
    expect(offersResumeCompaction(context(153_000), at + 2 * HOUR)).toBe(false);
    expect(offersResumeCompaction(undefined, at)).toBe(false);
  });

  it("knows when the offer becomes due", () => {
    expect(offerDueAt(context(153_000, at))).toBe(at + coldAfterMs(HOUR));
    expect(offerDueAt(context(50_000, at))).toBeUndefined();
    expect(offerDueAt(context(153_000, at, null))).toBeUndefined();
  });

  it("writes sizes in compact thousands", () => {
    expect(formatContextTokens(153_412)).toBe("153k");
    expect(formatContextTokens(4_000)).toBe("4k");
    expect(formatContextTokens(4_250)).toBe("4.3k");
    expect(formatContextTokens(1_200_000)).toBe("1.2m");
  });

  it("reads a stored list, and anything else as none", () => {
    expect(readList("not json")).toEqual([]);
    expect(readList(JSON.stringify(["a", 3]))).toEqual(["a"]);
  });
});
