import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { MAX_MEASURED_ROWS, TranscriptRowSizes, transcriptRowKind } from "./transcript-row-sizes";

const message = (role: UiMessage["role"], thinking?: string): UiMessage => ({ id: "m", role, text: "", timestamp: 0, ...(thinking ? { thinking } : {}) });

describe("transcript row sizes", () => {
  it("names a row's kind by role, thinking the view shows, and a turn's work", () => {
    expect(transcriptRowKind(message("user"), false)).toBe("user");
    expect(transcriptRowKind(message("user"), true)).toBe("user+work");
    expect(transcriptRowKind(message("assistant", "plan"), false)).toBe("assistant+thinking");
    expect(transcriptRowKind(message("assistant", "plan"), true, "focused")).toBe("assistant+work");
  });

  it("estimates an unmeasured row from the rows of its kind and keeps a measured row's own size", () => {
    const sizes = new TranscriptRowSizes();
    const fallback = sizes.size("new", "user");
    sizes.record("a", "user", 40);
    sizes.record("b", "user", 80);
    sizes.record("c", "assistant", 300);
    expect(sizes.size("new", "user")).toBe(60);
    expect(sizes.size("new", "assistant")).toBe(300);
    expect(sizes.size("new", "notice")).toBe(fallback);
    expect(sizes.size("a", "user")).toBe(40);

    // A re-measured row replaces its old size in the mean.
    sizes.record("b", "user", 120);
    expect(sizes.size("new", "user")).toBe(80);
  });

  it("tells which layouts already used a row's measured size", () => {
    const sizes = new TranscriptRowSizes();
    const first = sizes.beginLayout();
    sizes.record("a", "user", 40);
    expect(sizes.measuredBefore("a", first)).toBe(false);
    const second = sizes.beginLayout();
    expect(sizes.measuredBefore("a", second)).toBe(true);
    // Growing later does not make the row new again.
    sizes.record("a", "user", 90);
    expect(sizes.measuredBefore("a", second)).toBe(true);
    expect(sizes.measuredBefore("b", second)).toBe(false);
  });

  it("forgets the rows measured longest ago once threads have measured more than it keeps", () => {
    const sizes = new TranscriptRowSizes();
    sizes.record("first", "user", 500);
    sizes.record("kept", "user", 500);
    for (let index = 0; index < MAX_MEASURED_ROWS - 1; index += 1) {
      sizes.record(`other-${index}`, "user", 100);
      if (index === 0) sizes.record("kept", "user", 400);
    }
    expect(sizes.measuredBefore("first", Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(sizes.size("kept", "user")).toBe(400);
    expect(sizes.size("unmeasured", "user")).toBe(100);
  });
});
