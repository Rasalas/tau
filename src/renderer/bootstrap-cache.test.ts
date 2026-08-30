import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
import { readBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Cached", models: [{ provider: "p", id: "m", name: "M" }],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: Array.from({ length: 50 }, (_, index) => ({ id: String(index), role: "user", text: String(index), timestamp: index })),
  isStreaming: true, activeTools: ["bash"], allTools: [{ name: "bash", description: "shell" }], extensionCount: 1,
};

describe("bootstrap cache", () => {
  it("stores a bounded renderable shell without catalogs or running state", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } };
    writeBootstrapCache(snapshot, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.messages).toHaveLength(40);
    expect(cached?.snapshot.models).toEqual([]);
    expect(cached?.snapshot.allTools).toEqual([]);
    expect(cached?.snapshot.isStreaming).toBe(false);
  });
});
