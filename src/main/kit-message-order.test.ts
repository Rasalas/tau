import { describe, expect, it } from "vitest";
import { inStartOrder } from "./kit-message-order.js";
import { shellTranscriptPage } from "./persisted-transcript.js";

describe("a kit's messages in the order they began", () => {
  it("orders by time, keeping the store's order for equal times", () => {
    const messages = [{ id: "u2", timestamp: 5 }, { id: "a1", timestamp: 2 }, { id: "b", timestamp: 2 }];
    expect(inStartOrder(messages).map((message) => message.id)).toEqual(["a1", "b", "u2"]);
  });

  it("keeps the store's order when a message has no time", () => {
    const messages = [{ id: "u2", timestamp: 5 }, { id: "a1" }];
    expect(inStartOrder(messages).map((message) => message.id)).toEqual(["u2", "a1"]);
  });

  it("orders the page a released thread shows before its runtime opens", () => {
    const page = shellTranscriptPage("t", {
      updatedAt: 9,
      messages: [
        { role: "user", text: "do it", timestamp: 1 },
        { role: "user", text: "and the tests", timestamp: 5 },
        { role: "assistant", text: "On it.", timestamp: 2 },
      ] as never,
    });
    expect(page.messages.map((message) => message.text)).toEqual(["do it", "On it.", "and the tests"]);
  });
});
