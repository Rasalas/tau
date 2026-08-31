import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION, decodeHostUpdates, detailFromSnapshot, isHostUpdate } from "./host-protocol.js";
import type { HostSnapshot } from "./contracts.js";

const snapshot: HostSnapshot = {
  cwd: "/tmp/project", sessionId: "session", sessionTitle: "title", models: [],
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
    expect(detail.messages).toHaveLength(10);
    expect(detail.messages[0]?.id).toBe("31");
    expect(detail.olderCursor).toBe("31");
    expect(detail.hasMore).toBe(true);
    expect(detail).not.toHaveProperty("models");
  });

  it("keeps only activities anchored in the bounded detail", () => {
    const detail = detailFromSnapshot({
      ...snapshot,
      messages: Array.from({ length: 24 }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" as const : "user" as const, text: String(i), timestamp: i })),
      taskHistory: [
        { id: "old-task", anchorMessageId: "0", progress: { tasks: [], completed: 0, total: 0 } },
        { id: "recent-task", anchorMessageId: "20", progress: { tasks: [], completed: 0, total: 0 } },
      ],
    });
    expect(detail.taskHistory?.map((entry) => entry.id)).toEqual(["recent-task"]);
  });

  it("preserves a cursor when a cached snapshot is already bounded", () => {
    const detail = detailFromSnapshot({ ...snapshot, messages: snapshot.messages, olderCursor: "12" });
    expect(detail.olderCursor).toBe("12");
    expect(detail.hasMore).toBe(true);
  });

  it("translates a bounded bridge window to the raw cursor before its first visible turn", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({ id: String(index), role: "user" as const, text: String(index), timestamp: index }));
    const detail = detailFromSnapshot({
      ...snapshot,
      messages,
      transcriptMessageIndexes: messages.map((_, index) => index + 100),
    });
    expect(detail.messages.map((message) => message.id)).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 20)));
    expect(detail.transcriptMessageIndexes).toEqual(Array.from({ length: 10 }, (_, index) => index + 120));
    expect(detail.olderCursor).toBe("120");
  });
});
