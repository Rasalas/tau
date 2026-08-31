import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION, decodeHostUpdates, detailFromSnapshot, isHostUpdate } from "./host-protocol.js";
import type { HostSnapshot } from "./contracts.js";

const snapshot: HostSnapshot = {
  cwd: "/tmp/project", threadId: "thread", providerSessionId: "provider", sessionId: "thread", sessionTitle: "title", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: [
    { id: "1", role: "user", text: "hello", timestamp: 1 },
    { id: "2", role: "assistant", text: "world", timestamp: 2 },
  ], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
  serviceTier: "standard", serviceTierAvailable: false,
};

describe("host protocol", () => {
  it("accepts only the current version and known focused messages", () => {
    const update = { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 } };
    expect(isHostUpdate(update)).toBe(true);
    expect(decodeHostUpdates([
      update,
      { version: 99, type: "snapshot" },
      { type: "catalog" },
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: { sessionId: 42 } },
      { version: HOST_PROTOCOL_VERSION, type: "run", sessionId: "session", event: "unknown" },
    ])).toEqual([update]);
  });

  it("derives bounded detail without catalogs or project state", () => {
    const detail = detailFromSnapshot({ ...snapshot, messages: Array.from({ length: 41 }, (_, i) => ({ id: String(i), role: "user" as const, text: String(i), timestamp: i })) });
    expect(detail.messages).toHaveLength(40);
    expect(detail.olderCursor).toBe("1");
    expect(detail).toMatchObject({ threadId: "thread", providerSessionId: "provider", sessionId: "thread" });
    expect(detail).not.toHaveProperty("models");
  });
});
