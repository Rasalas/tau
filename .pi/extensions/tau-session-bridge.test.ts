import { describe, expect, it } from "vitest";
import { buildTranscriptView, InvalidBridgeTranscriptCursorError } from "./tau-session-bridge.js";

const branch = Array.from({ length: 25 }, (_, turn) => [
  { role: "user", text: `request ${turn}` },
  { role: "assistant", text: `answer ${turn}` },
]).flat();

describe("Tau bridge transcript cursor validation", () => {
  it.each([
    ["negative", "-1"],
    ["malformed", "not-a-cursor"],
    ["stale", String(branch.length + 1)],
    ["unsafe integer", "9007199254740992"],
  ])("rejects %s cursors before paging", (_label, cursor) => {
    try {
      buildTranscriptView(branch, { kind: "older-page", turnLimit: 20, cursor });
      throw new Error("expected cursor validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidBridgeTranscriptCursorError);
      expect((error as InvalidBridgeTranscriptCursorError).code).toBe("INVALID_BRIDGE_TRANSCRIPT_CURSOR");
    }
  });

  it("accepts the exact branch length and returns a deterministic bounded page", () => {
    const view = buildTranscriptView(branch, { kind: "older-page", turnLimit: 20, cursor: String(branch.length) });
    expect(view.visibleMessages.filter((message) => message.role === "user")).toHaveLength(20);
    expect(view.visibleMessages).toHaveLength(40);
    expect(view.hasMore).toBe(true);
    expect(view.olderCursor?.value).toBe("10");
  });
});
