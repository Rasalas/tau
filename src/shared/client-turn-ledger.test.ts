import { describe, expect, it } from "vitest";
import { ClientTurnLedgerStore } from "./client-turn-ledger.js";

describe("ClientTurnLedgerStore", () => {
  it("shares bounded queue and remembered cleanup semantics across host seams", () => {
    const store = new ClientTurnLedgerStore({
      pendingPerScope: 2,
      pendingTotal: 3,
      rememberedPerScope: 2,
      rememberedTotal: 3,
    });
    const identity = (index: number) => ({ clientTurnId: `turn-${index}`, clientMessageId: `message-${index}` });
    for (let index = 0; index < 8; index += 1) {
      store.enqueue(`session-${index}`, identity(index), { fingerprint: `prompt-${index}` });
      store.remember(`session-${index}`, { text: `prompt-${index}`, timestamp: index }, identity(index));
    }

    expect(store.pendingSize).toBeLessThanOrEqual(3);
    expect(store.rememberedSize).toBeLessThanOrEqual(3);
    store.clear("session-7");
    expect(store.rememberedEntries("session-7")).toHaveLength(0);
    store.clear();
    expect(store.size).toBe(0);
  });

  it("keeps raw correlation weak and removes pending identities by lifecycle", () => {
    const store = new ClientTurnLedgerStore();
    const identity = { clientTurnId: "turn", clientMessageId: "message" };
    const raw = {};
    store.enqueue("session", identity);
    const selected = store.findPending("session", () => true);
    expect(selected?.entry.identity).toEqual(identity);
    store.removePending(selected!);
    store.remember("session", { text: "prompt", timestamp: 1 }, identity, raw);
    expect(store.identityForRaw(raw)).toEqual(identity);
    store.cancel("session", identity);
    expect(store.size).toBe(0);
  });
});
