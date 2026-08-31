import { describe, expect, it } from "vitest";
import { asHostTranscriptCursor, isHostTranscriptCursor } from "./transcript-cursor.js";

describe("transcript cursor validation", () => {
  it("keeps host cursors opaque to shared consumers", () => {
    const cursor = asHostTranscriptCursor("opaque-host-cursor");
    expect(cursor).toBe("opaque-host-cursor");
    expect(isHostTranscriptCursor(cursor)).toBe(true);
  });

  it("rejects an empty host cursor without assigning coordinate semantics", () => {
    expect(() => asHostTranscriptCursor("")).toThrow("Invalid host transcript cursor");
    expect(isHostTranscriptCursor("")).toBe(false);
    expect(isHostTranscriptCursor({ kind: "bridge", value: "12" })).toBe(false);
  });
});
