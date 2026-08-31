import { describe, expect, it } from "vitest";
import {
  branchMessagesWithClientMessageIds,
  clientMessageFingerprint,
  clientMessageIdForMessage,
  CLIENT_MESSAGE_CANCEL_MARKER,
  CLIENT_MESSAGE_MARKER,
  unclaimedClientMessageIds,
} from "../shared/client-message-correlation.js";

function marker(customType: string, clientMessageId: string, text?: string, knownSkillNames: Iterable<string> = []) {
  return {
    type: "custom",
    customType,
    data: { clientMessageId, ...(text !== undefined ? { fingerprint: clientMessageFingerprint(text, knownSkillNames) } : {}) },
  };
}

describe("client message correlation", () => {
  it("projects persisted markers onto the exact user message", () => {
    const first = { role: "user", content: "same", timestamp: 1 };
    const second = { role: "user", content: "same", timestamp: 1 };
    const entries = [
      marker(CLIENT_MESSAGE_MARKER, "request-a", "same"),
      { type: "message", id: "entry-a", message: first },
      marker(CLIENT_MESSAGE_MARKER, "request-b", "same"),
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
      marker(CLIENT_MESSAGE_MARKER, "accepted", "next"),
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

  it("matches id-less messages by visible content instead of marker order", () => {
    const first = { role: "user", content: [{ type: "text", text: "first" }], timestamp: 4 };
    const second = { role: "user", content: [{ type: "text", text: "second" }], timestamp: 5 };
    const entries = [
      marker(CLIENT_MESSAGE_MARKER, "request-first", "first"),
      marker(CLIENT_MESSAGE_MARKER, "request-second", "second"),
      { type: "message", id: "entry-second", message: second },
      { type: "message", id: "entry-first", message: first },
    ];

    expect(branchMessagesWithClientMessageIds(entries)).toEqual([
      { ...second, clientMessageId: "request-second" },
      { ...first, clientMessageId: "request-first" },
    ]);
  });

  it("leaves an id-less message uncorrelated when its fingerprint is unknown", () => {
    const entries = [
      marker(CLIENT_MESSAGE_MARKER, "request-first", "first"),
      { type: "message", id: "entry", message: { role: "user", content: "different", timestamp: 6 } },
    ];
    expect(branchMessagesWithClientMessageIds(entries)).toEqual([
      { role: "user", content: "different", timestamp: 6 },
    ]);
    expect(unclaimedClientMessageIds(entries)).toEqual(["request-first"]);
  });

  it("correlates complete Pi skill wrappers by their visible suffix", () => {
    const wrapper = {
      role: "user",
      content: [{ type: "text", text: `<skill name="tdd" location="/private/SKILL.md">\nInjected body\n</skill>\n\nKeep this visible` }],
      timestamp: 7,
    };
    const entries = [marker(CLIENT_MESSAGE_MARKER, "request-skill", "Keep this visible"), { type: "message", id: "entry", message: wrapper }];
    expect(branchMessagesWithClientMessageIds(entries, ["tdd"])).toEqual([{ ...wrapper, clientMessageId: "request-skill" }]);
  });

  it("correlates a known plain slash skill after Pi expands it", () => {
    const expanded = {
      role: "user",
      content: [{ type: "text", text: `<skill name="tdd" location="/private/SKILL.md">\nInjected body\n</skill>\n\nKeep this visible` }],
      timestamp: 7,
    };
    const entries = [marker(CLIENT_MESSAGE_MARKER, "request-slash", "/tdd Keep this visible", ["tdd"]), { type: "message", id: "entry", message: expanded }];
    expect(branchMessagesWithClientMessageIds(entries, ["tdd"])).toEqual([{ ...expanded, clientMessageId: "request-slash" }]);
  });

  it("does not fingerprint an unknown wrapper as its visible suffix", () => {
    const wrapper = {
      role: "user",
      content: [{ type: "text", text: `<skill name="missing" location="/private/SKILL.md">\nInjected body\n</skill>\n\nKeep this visible` }],
      timestamp: 8,
    };
    const entries = [marker(CLIENT_MESSAGE_MARKER, "request-unknown", "Keep this visible"), { type: "message", id: "entry", message: wrapper }];
    expect(branchMessagesWithClientMessageIds(entries, ["tdd"])).toEqual([wrapper]);
    expect(unclaimedClientMessageIds(entries, ["tdd"])).toEqual(["request-unknown"]);
  });
});
