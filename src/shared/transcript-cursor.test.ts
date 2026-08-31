import { describe, expect, it } from "vitest";
import {
  parseTranscriptCursor,
  transcriptCursorIndex,
  type TranscriptCursor,
} from "./transcript-cursor.js";

describe("transcript cursor validation", () => {
  it("parses legacy strings in the declared coordinate space", () => {
    expect(parseTranscriptCursor("12", undefined, "bridge")).toEqual({ kind: "bridge", value: "12" });
    expect(() => parseTranscriptCursor("12", undefined, "local")).not.toThrow();
  });

  it("rejects a cursor whose origin contradicts the declared coordinate space", () => {
    const bridge: TranscriptCursor = { kind: "bridge", value: "12" as never };
    expect(() => parseTranscriptCursor(bridge, undefined, "local")).toThrow("coordinate space");
    expect(() => transcriptCursorIndex(bridge, 12, "local")).toThrow("coordinate space");
  });

  it("validates numeric bounds for both cursor origins", () => {
    expect(transcriptCursorIndex({ kind: "bridge", value: "12" as never }, 12, "bridge")).toBe(12);
    expect(() => transcriptCursorIndex({ kind: "bridge", value: "13" as never }, 12, "bridge")).toThrow("Invalid transcript cursor");
  });
});
