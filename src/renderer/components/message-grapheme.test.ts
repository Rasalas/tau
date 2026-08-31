import { afterEach, describe, expect, it } from "vitest";
import { fallbackGraphemeCount, GRAPHEME_CODEPOINT_BUDGET, isLongMessage } from "./message-grapheme";

describe("message grapheme boundaries", () => {
  const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter");

  afterEach(() => {
    if (segmenter) Object.defineProperty(Intl, "Segmenter", segmenter);
  });

  it("uses visible grapheme and line thresholds", () => {
    expect(isLongMessage(Array.from({ length: 8 }, () => "line").join("\n"))).toBe(false);
    expect(isLongMessage(Array.from({ length: 9 }, () => "line").join("\n"))).toBe(true);
    expect(isLongMessage("e\u0301".repeat(301))).toBe(false);
    expect(isLongMessage("a".repeat(600) + "\u0301")).toBe(false);
    expect(isLongMessage("a".repeat(601))).toBe(true);
    expect(isLongMessage("😀".repeat(600) + "a")).toBe(true);
  });

  it("keeps the fallback bounded and follows UAX-like joins", () => {
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    expect(isLongMessage("각".repeat(201))).toBe(false);
    expect(isLongMessage("👨‍👩‍👧‍👦".repeat(600))).toBe(false);
    expect(isLongMessage("👨‍👩‍👧‍👦".repeat(601))).toBe(true);
    expect(isLongMessage(("👨‍a".repeat(300)) + "👨")).toBe(true);
    expect(fallbackGraphemeCount("👨‍́👩", 600).count).toBe(2);
    expect(fallbackGraphemeCount("👨‍👩", 600).count).toBe(1);
    expect(fallbackGraphemeCount("👨‍‍👩", 600).count).toBe(2);
    expect(isLongMessage("a\u200db".repeat(301))).toBe(true);
    expect(isLongMessage("\u0301\u0302" + "a".repeat(599))).toBe(false);
    expect(isLongMessage("\u0301\u0302" + "a".repeat(600))).toBe(true);
    expect(isLongMessage("각".repeat(600))).toBe(false);
    expect(isLongMessage("각".repeat(600) + "가")).toBe(true);
    expect(isLongMessage("각" + "\u200d\u0301".repeat(10_000))).toBe(true);
    expect(isLongMessage("\u0301" + "a".repeat(600))).toBe(true);
    expect(isLongMessage("\u200d" + "a".repeat(600))).toBe(true);
    const englandFlag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    expect(isLongMessage(englandFlag.repeat(600))).toBe(false);
    expect(isLongMessage(englandFlag.repeat(600) + "a")).toBe(true);
    const bounded = fallbackGraphemeCount("\u0301".repeat(10_000_000), 600);
    expect(bounded.exhausted).toBe(true);
    expect(bounded.examinedCodePoints).toBe(GRAPHEME_CODEPOINT_BUDGET);
  });
});
