import { describe, expect, it } from "vitest";
import type { HostEvent } from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { ClientMessageTracker } from "./client-message-tracker.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import type { ThreadRuntime } from "./thread-runtime.js";

function stubThread(): ThreadRuntime {
  const entries: unknown[] = [];
  return {
    threadId: "session",
    entries,
    pendingClientMessageIds: [],
    pendingClientMessageFingerprints: new Map<string, string>(),
    inFlightClientMessageIds: new Set<string>(),
    appendJournalEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ThreadRuntime;
}

function piUserMessage(text: string): Record<string, unknown> {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("ClientMessageTracker.correlateStart", () => {
  it("claims the identity whose text matches when Pi delivers a later steer before an earlier follow-up", () => {
    const events: HostEvent[] = [];
    const ledger = new ClientTurnLedger();
    const tracker = new ClientMessageTracker(ledger, () => new Set(), () => ({}), (event) => events.push(event));
    const thread = stubThread();
    const followUp = { clientTurnId: "turn-follow-up", clientMessageId: "message-follow-up" };
    const steer = { clientTurnId: "turn-steer", clientMessageId: "message-steer" };
    const followUpText = "Wo bleibt die Antwort?";
    const steerText = "focus child im browser? hä? es geht hier um den chat";

    // The host accepted the follow-up first; Pi parks it until the run ends.
    ledger.enqueue("session", followUp, clientMessageFingerprint(followUpText));
    tracker.appendMarker(thread, followUp.clientMessageId, followUpText);
    // The steer arrives later and Pi delivers it after the current tool call.
    ledger.enqueue("session", steer, clientMessageFingerprint(steerText));
    tracker.appendMarker(thread, steer.clientMessageId, steerText);

    const steered = piUserMessage(steerText);
    tracker.correlateStart(thread, steered, "session");

    expect(steered.clientMessageId).toBe(steer.clientMessageId);
    expect(steered.tauClientTurnId).toBe(steer.clientTurnId);
    expect([...thread.inFlightClientMessageIds]).toEqual([steer.clientMessageId]);
    expect(thread.pendingClientMessageIds).toEqual([followUp.clientMessageId]);

    const delivered = piUserMessage(followUpText);
    tracker.correlateStart(thread, delivered, "session");
    expect(delivered.clientMessageId).toBe(followUp.clientMessageId);
    expect(thread.pendingClientMessageIds).toEqual([]);
    expect(events).toEqual([]);
  });
});
