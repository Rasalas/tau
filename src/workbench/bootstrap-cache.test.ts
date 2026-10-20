import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
import { detailFromSnapshot } from "../shared/host-protocol";
import { asHostTranscriptCursor } from "../shared/transcript-cursor";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "./client-storage";
import { flushBootstrapCache, readBootstrapCache, scheduleBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";
import { STORAGE_KEYS } from "./storage-keys";
import { TranscriptHistoryCache } from "./transcript-history-cache";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Cached", models: [{ provider: "p", id: "m", name: "M" }],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: Array.from({ length: 50 }, (_, index) => ({ id: String(index), role: "user", text: String(index), timestamp: index })),
  isStreaming: true, activeTools: ["bash"], allTools: [{ name: "bash", description: "shell" }], extensionCount: 1,
  supportsImageInput: true,
};

/** A read-only storage that answers `legacy` for `cacheKey` and nothing else. */
function legacyStorage(cacheKey: string, legacy: string): ClientStorage {
  return { get: (key) => key === cacheKey ? legacy : null, set: () => undefined, remove: () => undefined, keys: () => [] };
}

describe("bootstrap cache", () => {
  it("stores a bounded renderable shell without catalogs or running state", () => {
    const storage = createMemoryStorage();
    writeBootstrapCache(snapshot, { projects: [], sessions: [], runs: { session: 1_000 } }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.threadIndex.runs).toBeUndefined();
    expect(cached?.snapshot.messages).toHaveLength(10);
    expect(cached?.snapshot.models).toEqual([]);
    expect(cached?.snapshot.allTools).toEqual([]);
    expect(cached?.snapshot.isStreaming).toBe(false);
  });

  it("retains the active chat with a large index and coalesces pending updates", () => {
    const storage = createMemoryStorage();
    const index = { projects: [], sessions: Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), path: String(i), title: "Thread", modifiedAt: i, projectPath: "/p", projectName: "p", messageCount: 1 })) };
    scheduleBootstrapCache(snapshot, index, storage);
    scheduleBootstrapCache({ ...snapshot, sessionTitle: "Latest" }, index, storage);
    expect(readBootstrapCache(storage)).toBeUndefined();
    flushBootstrapCache(storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.sessionTitle).toBe("Latest");
    expect(cached?.snapshot.messages).toHaveLength(10);
    expect(cached?.threadIndex.sessions.length).toBeLessThanOrEqual(1_000);
    expect(cached?.savedAt).toBeTypeOf("number");
  });

  it("moves the cursor to the oldest retained turn after caching a paged transcript", () => {
    const storage = createMemoryStorage();
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
    const storage = createMemoryStorage();
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
    const storage = createMemoryStorage();
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
    const cached = readBootstrapCache(legacyStorage(cacheKey, legacy));
    expect(cached?.snapshot.olderCursor).toBeUndefined();
    expect(cached?.snapshot.historyCompleteness).toBe("unknown");
  });

  it("keeps the workspace identity through a round trip and reads a v6 cache that has none", () => {
    const storage = createMemoryStorage();
    writeBootstrapCache(
      { ...snapshot, workspaceId: "ws1_project", displayPath: "/project" },
      { projects: [{ path: "/project", workspaceId: "ws1_project", displayPath: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
      storage,
    );
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.workspaceId).toBe("ws1_project");
    expect(cached?.threadIndex.projects[0]?.workspaceId).toBe("ws1_project");

    // A cache written before identities still paints; it only lacks them.
    const legacy = JSON.stringify({ snapshot, threadIndex: { projects: [], sessions: [] } });
    const migrated = readBootstrapCache(legacyStorage("tau.bootstrap-cache.v6", legacy));
    expect(migrated?.snapshot.workspaceId).toBeUndefined();
    expect(migrated?.snapshot.cwd).toBe("/project");
  });

  it("keeps an unavailable cache limited without retaining a discarded cursor", () => {
    const storage = createMemoryStorage();
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
    const cached = readBootstrapCache(legacyStorage(cacheKey, legacy));
    expect(cached?.snapshot.olderCursor).toBeUndefined();
    expect(cached?.snapshot.historyCompleteness).toBe("unknown");
    expect(detailFromSnapshot(cached!.snapshot).historyCompleteness).toBe("unknown");
  });

  it("normalizes a stale v3 payload before first paint and ignores older cache keys", () => {
    const stale = JSON.stringify({ snapshot, threadIndex: { projects: [], sessions: [] } });
    const cached = readBootstrapCache(legacyStorage("tau.bootstrap-cache.v3", stale));
    expect(cached?.snapshot.messages).toHaveLength(10);
    expect(cached?.snapshot.messages[0]?.id).toBe("40");
    expect(cached?.snapshot.olderCursor).toBeUndefined();
    expect(cached?.snapshot.historyCompleteness).toBe("unknown");
    expect(detailFromSnapshot(cached!.snapshot).historyCompleteness).toBe("unknown");

    const oldOnly: ClientStorage = {
      get: (key) => key === "tau.bootstrap-cache.v2" || key === "tau.bootstrap-cache.v1" ? stale : null,
      set: () => undefined,
      remove: () => undefined,
      keys: () => [],
    };
    expect(readBootstrapCache(oldOnly)).toBeUndefined();
  });

  it("does not cache a cursor for leading orphan activities", () => {
    const storage = createMemoryStorage();
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
    const storage = legacyStorage("tau.bootstrap-cache.v1", JSON.stringify({ snapshot, threadIndex: { projects: [], sessions: [] } }));
    expect(readBootstrapCache(storage)).toBeUndefined();
  });

  it("drops only the oldest messages it must to fit, without serializing once per message", () => {
    const storage = createMemoryStorage();
    const messages = Array.from({ length: 10 }, (_, turn) => [
      { id: `user-${turn}`, role: "user" as const, text: `Prompt ${turn}`, timestamp: turn * 100 },
      ...Array.from({ length: 30 }, (_answer, index) => ({ id: `answer-${turn}-${index}`, role: "assistant" as const, text: "x".repeat(4_000), timestamp: turn * 100 + index + 1 })),
    ]).flat();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      writeBootstrapCache({ ...snapshot, messages }, { projects: [], sessions: [] }, storage);
      expect(stringify.mock.calls.length).toBeLessThan(20);
    } finally {
      stringify.mockRestore();
    }
    const raw = storage.get(STORAGE_KEYS.bootstrapCache)!;
    const size = new TextEncoder().encode(raw).length;
    expect(size).toBeLessThanOrEqual(512 * 1024);
    const cached = readBootstrapCache(storage)!;
    // Answers without their prompt go with it, so the window starts at a prompt and one more turn would not have fit.
    expect(cached.snapshot.messages[0]?.role).toBe("user");
    expect(size + 30 * 4_000).toBeGreaterThan(512 * 1024);
    expect(cached.snapshot.messages.at(-1)?.id).toBe("answer-9-29");
    expect(messages.slice(-cached.snapshot.messages.length).map((message) => message.id)).toEqual(cached.snapshot.messages.map((message) => message.id));
  });

  it("writes a new thread index with the coalesced write, not at once", () => {
    const storage = createMemoryStorage();
    setClientStorage(storage);
    try {
      const cache = new TranscriptHistoryCache(snapshot);
      for (let index = 0; index < 5; index += 1) cache.setThreadIndex({ projects: [], sessions: [] });
      expect(readBootstrapCache(storage)).toBeUndefined();
      flushBootstrapCache(storage);
      expect(readBootstrapCache(storage)?.snapshot.sessionId).toBe("session");
    } finally {
      setClientStorage(undefined);
    }
  });

  it("returns undefined without an installed storage", () => {
    expect(readBootstrapCache(undefined)).toBeUndefined();
  });
});
