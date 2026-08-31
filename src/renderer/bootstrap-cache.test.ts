import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
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

  it("keeps the host cursor after caching a previously paged transcript", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    const paged = {
      ...snapshot,
      messages: Array.from({ length: 30 }, (_, index) => ({ id: String(index + 20), role: "user" as const, text: String(index + 20), timestamp: index + 20 })),
      olderCursor: "11",
    };
    writeBootstrapCache(paged, { projects: [], sessions: [] }, storage);
    expect(readBootstrapCache(storage)?.snapshot.olderCursor).toBe("11");
  });
});
