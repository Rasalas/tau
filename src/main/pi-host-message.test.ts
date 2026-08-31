import { describe, expect, it } from "vitest";
import { mapBridgeMessages, mapBridgeTranscriptPageValue, mapMessage } from "./pi-host.js";

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

  it("maps bridge records and their raw indexes in one place", () => {
    const mapped = mapBridgeMessages([
      { role: "toolResult", content: "hidden" },
      { role: "user", content: "hello", tauEntryId: "entry-user" },
      { role: "assistant", content: "world", tauEntryId: "entry-assistant" },
    ], 40);
    expect(mapped.messages.map((message) => message.id)).toEqual(["entry-user", "entry-assistant"]);
    expect(mapped.transcriptMessageIndexes).toEqual([41, 42]);
  });

  it("rejects an invalid bridge offset instead of guessing a cursor", () => {
    expect(() => mapBridgeMessages([], -1)).toThrow("invalid transcript message offset");
    expect(() => mapBridgeMessages([], "40")).toThrow("invalid transcript message offset");
  });

  it("validates and maps bridge pages at the host seam", () => {
    expect(mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread",
      messages: [
        { role: "toolResult", content: "hidden" },
        { role: "user", content: "hello", tauEntryId: "user" },
      ],
      messagesOffset: 10,
      olderCursor: "4",
      hasMore: true,
    })).toMatchObject({
      sessionId: "thread",
      messages: [{ id: "user" }],
      transcriptMessageIndexes: [11],
      olderCursor: "4",
      hasMore: true,
    });
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread", messages: [], olderCursor: "bad", hasMore: false,
    })).toThrow("invalid transcript page cursor");
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread", messages: [], hasMore: true,
    })).toThrow("invalid transcript page");
  });
});
