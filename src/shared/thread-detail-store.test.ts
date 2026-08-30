import { describe, expect, it } from "vitest";
import { ThreadDetailStore, replaceDetailRecord } from "./thread-detail-store.js";
import type { ThreadDetail } from "./host-protocol.js";

const detail = (sessionId: string): ThreadDetail => ({ sessionId, messages: [], isStreaming: false, activeTools: [] });

describe("ThreadDetailStore", () => {
  it("evicts least recently used details at a fixed boundary", () => {
    const store = new ThreadDetailStore(2);
    store.set(detail("one")); store.set(detail("two"));
    expect(store.get("one")).toBeDefined();
    store.set(detail("three"));
    expect(store.has("one")).toBe(true);
    expect(store.has("two")).toBe(false);
  });

  it("replaces one record while retaining the original identity", () => {
    const current = detail("one");
    const next = replaceDetailRecord(current, { isStreaming: true });
    expect(next.sessionId).toBe("one");
    expect(next.messages).toBe(current.messages);
  });
});
