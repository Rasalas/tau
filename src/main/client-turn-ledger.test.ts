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

  it("does not consume a different optimistic turn for a mismatched explicit pair", () => {
    const ledger = new ClientTurnLedger();
    const first = { clientTurnId: "turn-first", clientMessageId: "message-first" };
    const second = { clientTurnId: "turn-second", clientMessageId: "message-second" };
    ledger.enqueue("session", first);
    ledger.enqueue("session", second);

    expect(ledger.claim("session", userMessage({
      text: "same prompt",
      clientTurnId: "turn-unknown",
      clientMessageId: "message-first",
    }))).toEqual({ clientTurnId: "turn-unknown", clientMessageId: "message-first" });
    expect(ledger.pendingSize).toBe(2);
  });

  it("does not let reused raw objects override a newer explicit identity", () => {
    const ledger = new ClientTurnLedger();
    const first = { clientTurnId: "turn-first", clientMessageId: "message-first" };
    const second = { clientTurnId: "turn-second", clientMessageId: "message-second" };
    const raw = {};
    ledger.enqueue("session", first);
    expect(ledger.claim("session", userMessage({ ...first }), raw)).toEqual(first);
    ledger.enqueue("session", second);

    expect(ledger.claim("session", userMessage({ ...second }), raw)).toEqual(second);
    expect(ledger.pendingSize).toBe(0);
  });

  it("bounds and cleans pending and remembered state", () => {
    const ledger = new ClientTurnLedger();
    for (let index = 0; index < 100; index += 1) {
      const identity = { clientTurnId: `turn-${index}`, clientMessageId: `message-${index}` };
      ledger.enqueue("session", identity);
    }
    expect(ledger.pendingSize).toBeLessThanOrEqual(64);

    const identity = { clientTurnId: "remembered-turn", clientMessageId: "remembered-message" };
    ledger.enqueue("settled", identity);
    ledger.claim("settled", userMessage({ text: "settled" }));
    expect(ledger.rememberedSize).toBe(1);
    ledger.settle("settled");
    expect(ledger.size).toBeLessThanOrEqual(64);
    ledger.clear();
    expect(ledger.size).toBe(0);
  });

  it("caps remembered identities across sessions and clears evicted sessions", () => {
    const ledger = new ClientTurnLedger();
    for (let index = 0; index < 1_200; index += 1) {
      const sessionId = `session-${index % 8}`;
      const identity = { clientTurnId: `remember-${index}`, clientMessageId: `message-${index}` };
      ledger.remember(sessionId, userMessage({ text: `remembered-${index}`, timestamp: index }), identity);
    }

    expect(ledger.rememberedSize).toBeLessThanOrEqual(1_024);
    ledger.clear("session-1");
    ledger.settle("session-2");
    expect(ledger.rememberedSize).toBeLessThanOrEqual(1_024);
    ledger.clear();
    expect(ledger.size).toBe(0);
  });

  it("keeps pending identities bounded across sessions", () => {
    const ledger = new ClientTurnLedger();
    for (let index = 0; index < 2_000; index += 1) {
      ledger.enqueue(`pending-session-${index}`, {
        clientTurnId: `pending-turn-${index}`,
        clientMessageId: `pending-message-${index}`,
      });
    }

    expect(ledger.pendingSize).toBeLessThanOrEqual(1_024);
  });
});
