import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
import { detailFromSnapshot } from "../shared/host-protocol";
import { asHostTranscriptCursor } from "../shared/transcript-cursor";
import { readBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Cached", models: [{ provider: "p", id: "m", name: "M" }],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: Array.from({ length: 50 }, (_, index) => ({ id: String(index), role: "user", text: String(index), timestamp: index })),
  isStreaming: true, activeTools: ["bash"], allTools: [{ name: "bash", description: "shell" }], extensionCount: 1,
  serviceTier: "standard", serviceTierAvailable: false,
  supportsImageInput: true,
};

describe("bootstrap cache", () => {
  it("stores a bounded renderable shell without catalogs or running state", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    writeBootstrapCache(snapshot, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.messages).toHaveLength(10);
    expect(cached?.snapshot.models).toEqual([]);
    expect(cached?.snapshot.allTools).toEqual([]);
    expect(cached?.snapshot.isStreaming).toBe(false);
  });

  it("moves the cursor to the oldest retained turn after caching a paged transcript", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    const paged = {
      ...snapshot,
      messages: Array.from({ length: 30 }, (_, index) => ({ id: String(index + 20), role: "user" as const, text: String(index + 20), timestamp: index + 20 })),
      olderCursor: asHostTranscriptCursor("opaque:cursor-before-20"),
      cursorBeforeMessageId: "40",
      cursorBoundaries: [{ messageId: "40", cursor: asHostTranscriptCursor("opaque:cursor-before-40") }],
    };
    writeBootstrapCache(paged, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.olderCursor).toBe(asHostTranscriptCursor("opaque:cursor-before-40"));
    expect(cached?.snapshot.cursorBeforeMessageId).toBe("40");
    expect(detailFromSnapshot(cached!.snapshot).olderCursor).toBe(asHostTranscriptCursor("opaque:cursor-before-40"));
  });

  it("keeps an opaque boundary when trimming a retained window", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    const bridged = {
      ...snapshot,
      messages: Array.from({ length: 30 }, (_, index) => ({ id: String(index + 20), role: "user" as const, text: String(index + 20), timestamp: index + 20 })),
      olderCursor: asHostTranscriptCursor("opaque:cursor-before-40"),
      cursorBeforeMessageId: "40",
    };
    writeBootstrapCache(bridged, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.olderCursor).toBe(asHostTranscriptCursor("opaque:cursor-before-40"));
    expect(detailFromSnapshot(cached!.snapshot).olderCursor).toBe(asHostTranscriptCursor("opaque:cursor-before-40"));
  });

  it("retains an opaque host cursor without exposing its adapter coordinate", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    const bridged = {
      ...snapshot,
      messages: Array.from({ length: 30 }, (_, index) => ({ id: String(index), role: "user" as const, text: String(index), timestamp: index })),
      olderCursor: asHostTranscriptCursor("opaque:bridge-cursor"),
      cursorBeforeMessageId: "20",
    };
    writeBootstrapCache(bridged, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.olderCursor).toBe(asHostTranscriptCursor("opaque:bridge-cursor"));
    expect(detailFromSnapshot(cached!.snapshot).olderCursor).toBe(asHostTranscriptCursor("opaque:bridge-cursor"));
  });

  it.each(["tau.bootstrap-cache.v3", "tau.bootstrap-cache.v4"])("migrates %s without interpreting its legacy coordinate object", (cacheKey) => {
    const legacy = JSON.stringify({
      snapshot: {
        ...snapshot,
        messages: Array.from({ length: 30 }, (_, index) => ({ id: String(index), role: "user", text: String(index), timestamp: index })),
        olderCursor: { kind: "bridge", value: "20" },
        historyCompleteness: "complete",
      },
      threadIndex: { projects: [], sessions: [] },
    });
    const storage = {
      getItem: (key: string) => key === cacheKey ? legacy : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.olderCursor).toBeUndefined();
    expect(cached?.snapshot.historyCompleteness).toBe("unknown");
  });

  it("keeps an unavailable cache limited without retaining a discarded cursor", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    writeBootstrapCache({
      ...snapshot,
      messages: Array.from({ length: 160 }, (_, index) => ({ id: String(index), role: "user" as const, text: String(index), timestamp: index })),
      olderCursor: asHostTranscriptCursor("opaque:discarded"),
      historyCompleteness: "unknown",
    }, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.messages).toHaveLength(10);
    expect(cached?.snapshot.olderCursor).toBeUndefined();
    expect(cached?.snapshot.historyCompleteness).toBe("unknown");
    expect(detailFromSnapshot(cached!.snapshot).olderCursor).toBeUndefined();
  });

  it.each(["tau.bootstrap-cache.v3", "tau.bootstrap-cache.v4"])("normalizes %s has-more without a host cursor", (cacheKey) => {
    const legacy = JSON.stringify({
      snapshot: {
        ...snapshot,
        messages: Array.from({ length: 10 }, (_, index) => ({ id: String(index), role: "user", text: String(index), timestamp: index })),
        olderCursor: { kind: "bridge", value: "5" },
        historyCompleteness: "has-more",
      },
      threadIndex: { projects: [], sessions: [] },
    });
    const storage = {
      getItem: (key: string) => key === cacheKey ? legacy : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.olderCursor).toBeUndefined();
    expect(cached?.snapshot.historyCompleteness).toBe("unknown");
    expect(detailFromSnapshot(cached!.snapshot).historyCompleteness).toBe("unknown");
  });

  it("normalizes a stale v3 payload before first paint and ignores older cache keys", () => {
    const stale = JSON.stringify({ snapshot, threadIndex: { projects: [], sessions: [] } });
    const storage = {
      getItem: (key: string) => key === "tau.bootstrap-cache.v3" ? stale : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.messages).toHaveLength(10);
    expect(cached?.snapshot.messages[0]?.id).toBe("40");
    expect(cached?.snapshot.olderCursor).toBeUndefined();
    expect(cached?.snapshot.historyCompleteness).toBe("unknown");
    expect(detailFromSnapshot(cached!.snapshot).historyCompleteness).toBe("unknown");

    const oldOnly = {
      getItem: (key: string) => key === "tau.bootstrap-cache.v2" || key === "tau.bootstrap-cache.v1" ? stale : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(readBootstrapCache(oldOnly)).toBeUndefined();
  });

  it("does not cache a cursor for leading orphan activities", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    writeBootstrapCache({
      ...snapshot,
      messages: [
        { id: "user", role: "user", text: "hello", timestamp: 5 },
        { id: "answer", role: "assistant", text: "world", timestamp: 6 },
      ],
    }, { projects: [], sessions: [] }, storage);
    expect(readBootstrapCache(storage)?.snapshot.olderCursor).toBeUndefined();
  });

  it("does not hydrate legacy snapshots that may contain raw skill envelopes", () => {
    const storage = {
      getItem: (key: string) => key === "tau.bootstrap-cache.v1"
        ? JSON.stringify({ snapshot, threadIndex: { projects: [], sessions: [] } })
        : null,
    };
    expect(readBootstrapCache(storage)).toBeUndefined();
  });
});
