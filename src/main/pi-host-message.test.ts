import { describe, expect, it } from "vitest";
import { historyCompletenessForBridgeSnapshot, mapBridgeMessages, mapBridgeTranscriptPageValue, mapMessage } from "./pi-host.js";
import { decodeHostCursor } from "./transcript-cursor.js";

describe("Pi message mapping", () => {
  it("keeps user image content for the renderer", () => {
    expect(mapMessage({
      role: "user",
      content: [
        { type: "text", text: "please inspect" },
        { type: "image", mimeType: "image/png", data: "iVBORw==" },
      ],
      timestamp: 1,
    }, 0)).toMatchObject({
      role: "user",
      text: "please inspect",
      images: [{ mimeType: "image/png", data: "iVBORw==" }],
    });
  });

  it("maps bridge records without leaking provider coordinates", () => {
    const mapped = mapBridgeMessages([
      { role: "toolResult", content: "hidden" },
      { role: "user", content: "hello", tauEntryId: "entry-user" },
      { role: "assistant", content: "world", tauEntryId: "entry-assistant" },
    ], 40);
    expect(mapped.messages.map((message) => message.id)).toEqual(["entry-user", "entry-assistant"]);
    expect(mapped).not.toHaveProperty("transcriptMessageIndexes");
  });

  it("rejects an invalid bridge offset instead of guessing a cursor", () => {
    expect(() => mapBridgeMessages([], -1)).toThrow("invalid transcript message offset");
    expect(() => mapBridgeMessages([], "40")).toThrow("invalid transcript message offset");
  });

  it("validates and maps bridge pages at the host seam", () => {
    const page = mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread",
      messages: [
        { role: "toolResult", content: "hidden" },
        { role: "user", content: "hello", tauEntryId: "user" },
      ],
      messagesOffset: 10,
      olderCursor: "provider-token",
      hasMore: true,
    });
    expect(page).toMatchObject({
      sessionId: "thread",
      messages: [{ id: "user" }],
      transcriptWindow: "bounded",
      olderCursor: expect.any(String),
      hasMore: true,
    });
    expect(decodeHostCursor(page.olderCursor)).toEqual({ kind: "bridge", value: "provider-token" });
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread", messages: [], olderCursor: "", hasMore: false,
    })).toThrow("invalid transcript page cursor");
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread", messages: [], hasMore: true,
    })).toThrow("invalid transcript page");
  });

  it.each([
    ["complete with cursor", { olderCursor: "4", hasMore: false, historyCompleteness: "complete" }],
    ["has-more without cursor", { hasMore: true, historyCompleteness: "has-more" }],
    ["legacy-truncated with cursor", { olderCursor: "4", hasMore: false, historyCompleteness: "legacy-truncated" }],
    ["unknown with cursor", { olderCursor: "4", hasMore: false, historyCompleteness: "unknown" }],
  ])("rejects contradictory bridge page metadata: %s", (_label, metadata) => {
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread",
      messages: [],
      ...metadata,
    })).toThrow("invalid transcript page");
  });

  it("marks a capped legacy bridge snapshot as truncated rather than complete", () => {
    const sourceBranch = Array.from({ length: 161 }, (_, index) => ({ role: "user", index }));
    const messages = sourceBranch.slice(-160);
    expect(historyCompletenessForBridgeSnapshot({
      messages,
      capabilities: undefined,
    })).toBe("legacy-truncated");
    expect(historyCompletenessForBridgeSnapshot({
      messages: messages.slice(0, 159),
      capabilities: undefined,
    })).toBe("unknown");
  });

  it("uses negotiated paging metadata instead of the legacy cap", () => {
    expect(historyCompletenessForBridgeSnapshot({
      messages: Array.from({ length: 160 }, () => ({ role: "user" })),
      capabilities: { transcriptPaging: true },
      olderCursor: "80",
    })).toBe("has-more");
    expect(historyCompletenessForBridgeSnapshot({
      messages: [],
      capabilities: { transcriptPaging: true },
    })).toBe("complete");
  });

  it("keeps contradictory has-more metadata limited when no cursor is available", () => {
    expect(historyCompletenessForBridgeSnapshot({
      messages: [],
      capabilities: { transcriptPaging: true },
      historyCompleteness: "has-more",
    })).toBe("unknown");
  });

  it("does not trust a legacy complete claim over the bounded record cap", () => {
    expect(historyCompletenessForBridgeSnapshot({
      messages: Array.from({ length: 160 }, () => ({ role: "user" })),
      capabilities: undefined,
      historyCompleteness: "complete",
    })).toBe("legacy-truncated");
  });
});
