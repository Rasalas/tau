import { describe, expect, it } from "vitest";
import { mapMessage } from "./pi-host.js";

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

  it("preserves client turn metadata from a bridge or persisted snapshot", () => {
    expect(mapMessage({
      role: "user",
      content: [{ type: "text", text: "expanded template" }],
      timestamp: 2,
      tauEntryId: "entry",
      clientTurnId: "turn-1",
      clientMessageId: "message-1",
    }, 0)).toMatchObject({
      id: "entry",
      clientTurnId: "turn-1",
      clientMessageId: "message-1",
    });
  });
});
