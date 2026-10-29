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

it("does not retain a single oversized detail and evicts whole records by total message weight", () => {
  const store = new ThreadDetailStore(5);
  store.set({ ...detail("large"), messages: Array.from({ length: 6000 }, (_, index) => ({ id: String(index), role: "user", text: "hello", timestamp: 1 })) });
  expect(store.has("large")).toBe(false);
  store.set({ ...detail("bytes"), messages: [{ id: "huge", role: "user", text: "x".repeat(17 * 1024 * 1024), timestamp: 1 }] });
  expect(store.has("bytes")).toBe(false);
});

it("budgets messages across threads and releases their weights on replacement and clear", () => {
  const store = new ThreadDetailStore(24);
  const many = (id: string) => ({ ...detail(id), messages: Array.from({ length: 2000 }, (_, n) => ({ id: `${id}-${n}`, role: "user" as const, text: "hi", timestamp: 1 })) });
  store.set(many("one")); store.set(many("two"));
  store.get("one");
  store.set(many("three"));
  expect(store.ids()).toEqual(["one", "three"]);
  store.set(detail("one"));
  store.set(many("four"));
  expect(store.has("three")).toBe(true);
  store.clear();
  store.set(many("five")); store.set(many("six"));
  expect(store.size).toBe(2);
});

it("evicts by aggregate bytes even when each thread fits independently", () => {
  const store = new ThreadDetailStore(24);
  const large = (id: string) => ({ ...detail(id), messages: [{ id, role: "user" as const, text: "x".repeat(9 * 1024 * 1024), timestamp: 1 }] });
  store.set(large("one"));
  store.set(large("two"));
  expect(store.ids()).toEqual(["two"]);
  expect(store.get("two")?.messages[0]?.text.length).toBe(9 * 1024 * 1024);
});
