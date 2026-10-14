import { describe, expect, it } from "vitest";
import { RailStore } from "./store.js";

describe("rail snapshot ordering", () => {
  it("does not let a late reply establish an unseen old epoch after a new activation push", () => {
    const store = new RailStore();
    const request = { epoch: store.getState().publication?.epoch };
    const pending = store.beginPatch({ a: { settledAt: 1, settledBy: "user" } });
    store.set({ threads: {}, publication: { epoch: "new", revision: 0 } });
    store.finishPatch(pending, { threads: { a: { settledAt: 1 } }, publication: { epoch: "old", revision: 5 } }, request);
    expect(store.getState().publication?.epoch).toBe("new");
    expect(store.getState().threads.a?.settledAt).toBeUndefined();
    store.set({ threads: { a: { settledAt: 2 } }, publication: { epoch: "new", revision: 1 } });
    expect(store.getState().threads.a?.settledAt).toBe(2);
  });
});
