// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { compactTimestamp } from "./message-timestamp";

afterEach(() => { delete document.documentElement.dataset.timestamps; });

const AFTERNOON = new Date(2026, 8, 22, 15, 4).getTime();

describe("message timestamps", () => {
  it("keep the 24-hour clock unless <html> asks for another", () => {
    expect(compactTimestamp(AFTERNOON)).toContain("15:04");
    document.documentElement.dataset.timestamps = "12h";
    expect(compactTimestamp(AFTERNOON)).toMatch(/03:04|3:04/u);
    expect(compactTimestamp(AFTERNOON)).not.toContain("15:04");
  });
});
