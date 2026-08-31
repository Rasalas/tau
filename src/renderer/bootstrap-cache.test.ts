import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
import { detailFromSnapshot } from "../shared/host-protocol";
import { readBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Cached", models: [{ provider: "p", id: "m", name: "M" }],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: Array.from({ length: 50 }, (_, index) => ({ id: String(index), role: "user", text: String(index), timestamp: index })),
  isStreaming: true, activeTools: ["bash"], allTools: [{ name: "bash", description: "shell" }], extensionCount: 1,
  serviceTier: "standard", serviceTierAvailable: false,
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
      olderCursor: "11",
    };
    writeBootstrapCache(paged, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.olderCursor).toBe("31");
    expect(detailFromSnapshot(cached!.snapshot).olderCursor).toBe("31");
  });

  it("keeps a bridge raw cursor when the retained window carries source indexes", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    const bridged = {
      ...snapshot,
      messages: Array.from({ length: 30 }, (_, index) => ({ id: String(index + 20), role: "user" as const, text: String(index + 20), timestamp: index + 20 })),
      transcriptMessageIndexes: Array.from({ length: 30 }, (_, index) => index + 100),
      olderCursor: "100",
    };
    writeBootstrapCache(bridged, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.transcriptMessageIndexes).toEqual(Array.from({ length: 10 }, (_, index) => index + 120));
    expect(cached?.snapshot.olderCursor).toBe("120");
    expect(detailFromSnapshot(cached!.snapshot).olderCursor).toBe("120");
  });
});
