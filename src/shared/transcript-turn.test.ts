import { describe, expect, it } from "vitest";
import { clientIdentityMatches, matchesTranscriptTurnMessage, resolveClientTurnIdentity } from "./transcript-turn.js";

describe("matchesTranscriptTurnMessage", () => {
  it("requires the complete explicit identity before considering a match", () => {
    const turn = {
      turnId: "turn-local",
      clientMessageId: "message-local",
      messageId: "same-entry",
      text: "same prompt",
      timestamp: 10,
    };
    expect(matchesTranscriptTurnMessage({
      role: "user",
      id: "same-entry",
      text: "same prompt",
      timestamp: 10,
      clientTurnId: "turn-other",
      clientMessageId: "message-other",
    }, turn)).toBe(false);
  });

  it("uses the message ID and timestamp only for an idless authoritative record", () => {
    const turn = { turnId: "turn", messageId: "saved", text: "prompt", timestamp: 1_000 };
    expect(matchesTranscriptTurnMessage({ role: "user", id: "saved", text: "different", timestamp: 1 }, turn)).toBe(true);
    expect(matchesTranscriptTurnMessage({ role: "user", id: "other", text: "prompt", timestamp: 1_020 }, turn)).toBe(true);
    expect(matchesTranscriptTurnMessage({ role: "user", id: "other", text: "prompt", timestamp: 40_000 }, turn)).toBe(false);
  });

  it("allows an explicit legacy text fallback only when the caller opts in", () => {
    const message = { role: "user" as const, id: "saved", text: "expanded", timestamp: 1 };
    const turn = { turnId: "turn", text: "expanded", timestamp: 50_000 };
    expect(matchesTranscriptTurnMessage(message, turn)).toBe(false);
    expect(matchesTranscriptTurnMessage(message, turn, { allowUnclockedTextFallback: true })).toBe(true);
  });
});

describe("resolveClientTurnIdentity", () => {
  it("never replaces partial or explicit metadata with an idless fallback", () => {
    const fallback = { clientTurnId: "fallback-turn", clientMessageId: "fallback-message" };
    expect(resolveClientTurnIdentity({}, fallback)).toEqual(fallback);
    expect(resolveClientTurnIdentity({ clientTurnId: "partial" }, fallback)).toBeUndefined();
    expect(resolveClientTurnIdentity({ clientTurnId: "explicit", clientMessageId: "message" }, fallback))
      .toEqual({ clientTurnId: "explicit", clientMessageId: "message" });
  });

  it("does not match an incomplete explicit pair to an optimistic identity", () => {
    const expected = { clientTurnId: "turn", clientMessageId: "message" };
    expect(clientIdentityMatches({ clientTurnId: expected.clientTurnId }, expected)).toBe(false);
    expect(clientIdentityMatches({ clientMessageId: expected.clientMessageId }, expected)).toBe(false);
  });
});
