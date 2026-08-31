import { describe, expect, it } from "vitest";
import {
  branchMessagesWithClientMessageIds,
  clientMessageIdForMessage,
  CLIENT_MESSAGE_CANCEL_MARKER,
  CLIENT_MESSAGE_MARKER,
  unclaimedClientMessageIds,
} from "./client-message-correlation.js";

function marker(customType: string, clientMessageId: string) {
  return { type: "custom", customType, data: { clientMessageId } };
}

describe("client message correlation", () => {
  it("projects persisted markers onto the exact user message", () => {
    const first = { role: "user", content: "same", timestamp: 1 };
    const second = { role: "user", content: "same", timestamp: 1 };
    const entries = [
      marker(CLIENT_MESSAGE_MARKER, "request-a"),
      { type: "message", id: "entry-a", message: first },
      marker(CLIENT_MESSAGE_MARKER, "request-b"),
      { type: "message", id: "entry-b", message: second },
    ];

    expect(branchMessagesWithClientMessageIds(entries)).toEqual([
      { ...first, clientMessageId: "request-a" },
      { ...second, clientMessageId: "request-b" },
    ]);
    expect(clientMessageIdForMessage(entries, first)).toBe("request-a");
    expect(clientMessageIdForMessage(entries, second)).toBe("request-b");
    // A copied message with equal text/timestamp is not an identity match.
    expect(clientMessageIdForMessage(entries, { ...first })).toBeUndefined();
  });

  it("does not resurrect a cancelled marker after a failed request", () => {
    const message = { role: "user", content: "next", timestamp: 2 };
    const entries = [
      marker(CLIENT_MESSAGE_MARKER, "failed"),
      marker(CLIENT_MESSAGE_CANCEL_MARKER, "failed"),
      marker(CLIENT_MESSAGE_MARKER, "accepted"),
      { type: "message", id: "entry", message },
    ];
    expect(branchMessagesWithClientMessageIds(entries)).toEqual([{ ...message, clientMessageId: "accepted" }]);
  });

  it("identifies only markers with no persisted user message for restart cleanup", () => {
    const persisted = { role: "user", content: "accepted", timestamp: 1, clientMessageId: "accepted" };
    expect(unclaimedClientMessageIds([
      marker(CLIENT_MESSAGE_MARKER, "accepted"),
      { type: "message", id: "accepted-entry", message: persisted },
      marker(CLIENT_MESSAGE_MARKER, "failed"),
    ])).toEqual(["failed"]);
  });

  it("does not let an orphaned marker claim a later unmarked user message", () => {
    const laterMessage = { role: "user", content: "typed in Pi", timestamp: 2 };
    const entries = [
      marker(CLIENT_MESSAGE_MARKER, "orphaned"),
      { type: "message", id: "later-entry", message: laterMessage },
    ];

    expect(unclaimedClientMessageIds(entries)).toEqual(["orphaned"]);
    expect(branchMessagesWithClientMessageIds([
      ...entries,
      marker(CLIENT_MESSAGE_CANCEL_MARKER, "orphaned"),
    ])).toEqual([laterMessage]);
  });

  it("uses persisted ids when messages arrive after multiple queued markers", () => {
    const first = { role: "user", content: "same", timestamp: 3, clientMessageId: "request-a" };
    const second = { role: "user", content: "same", timestamp: 3, clientMessageId: "request-b" };
    const entries = [
      marker(CLIENT_MESSAGE_MARKER, "request-a"),
      marker(CLIENT_MESSAGE_MARKER, "request-b"),
      { type: "message", id: "entry-a", message: first },
      { type: "message", id: "entry-b", message: second },
    ];

    expect(branchMessagesWithClientMessageIds(entries)).toEqual([first, second]);
    expect(clientMessageIdForMessage(entries, { ...first })).toBe("request-a");
    expect(clientMessageIdForMessage(entries, { ...second })).toBe("request-b");
  });
});
