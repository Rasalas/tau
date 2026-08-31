import { describe, expect, it } from "vitest";
import type { UiMessage } from "../shared/contracts.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";

function userMessage(overrides: Partial<UiMessage>): UiMessage {
  return {
    id: "authoritative",
    role: "user",
    text: "expanded prompt",
    timestamp: 10,
    ...overrides,
  };
}

describe("ClientTurnLedger", () => {
  it.each([
    ["/skill:review", "Expanded skill instructions"],
    ["/template:ship", "Expanded template instructions"],
  ])("keeps a queued %s identity when Pi emits authoritative text", (submittedText, expandedText) => {
    const ledger = new ClientTurnLedger();
    const identity = { clientTurnId: `turn-${submittedText}`, clientMessageId: `message-${submittedText}` };
    ledger.enqueue("session", identity);

    expect(ledger.claim("session", userMessage({ text: expandedText }))).toEqual(identity);
  });

  it("matches out-of-order identical prompts by their explicit identity", () => {
    const ledger = new ClientTurnLedger();
    const first = { clientTurnId: "turn-first", clientMessageId: "message-first" };
    const second = { clientTurnId: "turn-second", clientMessageId: "message-second" };
    ledger.enqueue("session", first);
    ledger.enqueue("session", second);

    expect(ledger.claim("session", userMessage({
      text: "expanded same prompt",
      clientTurnId: second.clientTurnId,
      clientMessageId: second.clientMessageId,
    }))).toEqual(second);
    expect(ledger.claim("session", userMessage({
      text: "expanded same prompt",
      clientTurnId: first.clientTurnId,
      clientMessageId: first.clientMessageId,
    }))).toEqual(first);
  });

  it("consumes a new-session identity before later session-scoped sends", () => {
    const ledger = new ClientTurnLedger();
    const draft = { clientTurnId: "turn-draft", clientMessageId: "message-draft" };
    const later = { clientTurnId: "turn-later", clientMessageId: "message-later" };
    ledger.enqueueAny(draft);
    ledger.enqueue("session", later);

    expect(ledger.claim("session", userMessage({ text: "expanded draft" }))).toEqual(draft);
    expect(ledger.claim("session", userMessage({ text: "expanded later" }))).toEqual(later);
  });

  it("makes the claimed identity available while building a later snapshot", () => {
    const ledger = new ClientTurnLedger();
    const identity = { clientTurnId: "turn-snapshot", clientMessageId: "message-snapshot" };
    const raw = {};
    ledger.enqueue("session", identity);
    ledger.claim("session", userMessage({ text: "expanded" }), raw);

    expect(ledger.identityForRaw(raw)).toEqual(identity);
    expect(ledger.identityForMessage("session", userMessage({
      text: "expanded",
      timestamp: 10,
    }))).toEqual(identity);
  });
});
