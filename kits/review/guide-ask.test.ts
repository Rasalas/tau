import { describe, expect, it } from "vitest";
import { askChip } from "./guide-ask.js";
import type { GuideStop } from "./guide-protocol.js";

const STOP: GuideStop = {
  title: "The reader keeps its place",
  summary: "Progress is held per head.",
  attention: { kind: "tradeoff", note: "Memory only." },
  excerpts: [{ path: "kits/review/a.ts", side: "new", start: 4, end: 9, caption: "" }, { path: "kits/review/b.ts", side: "old", start: 1, end: 2, caption: "" }],
  files: [],
  notes: [],
  questions: [],
};

describe("the chip about a stop", () => {
  it("carries the stop, its lines and the question", () => {
    const chip = askChip({ noun: "PR", number: 7 }, STOP, 1, 5, "Why not disk?");
    expect(chip.label).toBe("Stop 2: The reader keeps its place");
    expect(chip.payload.source).toBe("Review guide of PR #7");
    expect(chip.payload.text).toContain("Stop 2 of 5: The reader keeps its place");
    expect(chip.payload.text).toContain("Progress is held per head.");
    expect(chip.payload.text).toContain("A tradeoff to weigh: Memory only.");
    expect(chip.payload.text).toContain("- kits/review/a.ts:4-9\n- kits/review/b.ts:1-2 (before the change)");
    expect(chip.payload.text).toContain("Question: Why not disk?");
  });

  it("leaves the question out when the reader only asks about the stop, and cuts a long label", () => {
    const chip = askChip({ noun: "MR", number: 2 }, { ...STOP, title: "x".repeat(80), attention: null, excerpts: [] }, 0, 1, "  ");
    expect(chip.payload.text).not.toContain("Question");
    expect(chip.label!.length).toBeLessThanOrEqual(50);
  });
});
