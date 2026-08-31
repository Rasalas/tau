import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION, catalogFromSnapshot, decodeHostUpdates, detailFromSnapshot, isHostUpdate } from "./host-protocol.js";
import { normalizeTranscriptCursorBoundaries, threadDetailFromHostSnapshot } from "./host-protocol.js";
import type { HostSnapshot } from "./contracts.js";
import { asHostTranscriptCursor, type HostTranscriptCursor } from "./transcript-cursor.js";
import type { TranscriptCursorPolicy } from "./transcript-pager.js";

const snapshot: HostSnapshot = {
  cwd: "/tmp/project", threadId: "thread", providerSessionId: "provider", sessionId: "session", sessionTitle: "title", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: [
    { id: "1", role: "user", text: "hello", timestamp: 1 },
    { id: "2", role: "assistant", text: "world", timestamp: 2 },
  ], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
  serviceTier: "standard", serviceTierAvailable: false,
  supportsImageInput: true,
};

const localCursorPolicy: TranscriptCursorPolicy<HostTranscriptCursor> = {
  cursorAtIndex: (index) => asHostTranscriptCursor(`local:${index}`),
  indexFromCursor: (cursor, maximum) => {
    const value = cursor.slice("local:".length);
    if (!cursor.startsWith("local:") || !/^\d+$/u.test(value) || Number(value) > maximum) throw new Error("Invalid transcript cursor");
    return Number(value);
  },
};

describe("host protocol", () => {
  it("accepts only the current version and known focused messages", () => {
    const update = { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true } };
    expect(isHostUpdate(update)).toBe(true);
    expect(isHostUpdate({ ...update, catalog: { ...update.catalog, supportsImageInput: undefined } })).toBe(true);
    expect(isHostUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 } })).toBe(true);
    expect(catalogFromSnapshot({ ...snapshot, supportsImageInput: undefined }).supportsImageInput).toBe(false);
    expect(decodeHostUpdates([
      update,
      { version: 99, type: "snapshot" },
      { type: "catalog" },
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: { sessionId: 42 } },
      { version: HOST_PROTOCOL_VERSION, type: "run", sessionId: "session", event: "unknown" },
    ])).toEqual([update]);
  });

  it("derives bounded detail without catalogs or project state", () => {
    const detail = detailFromSnapshot({ ...snapshot, messages: Array.from({ length: 41 }, (_, i) => ({ id: String(i), role: "user" as const, text: String(i), timestamp: i })) }, undefined, localCursorPolicy);
    expect(detail.messages).toHaveLength(10);
    expect(detail.messages[0]?.id).toBe("31");
    expect(detail.olderCursor).toBe(asHostTranscriptCursor("local:31"));
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
    }, undefined, localCursorPolicy);
    expect(detail.taskHistory?.map((entry) => entry.id)).toEqual(["recent-task"]);
  });

  it("preserves a cursor when a cached snapshot is already bounded", () => {
    const detail = detailFromSnapshot({ ...snapshot, messages: snapshot.messages, olderCursor: asHostTranscriptCursor("local:12") });
    expect(detail.olderCursor).toBe(asHostTranscriptCursor("local:12"));
    expect(detail.hasMore).toBe(true);
  });

  it("keeps the host cursor opaque while bounding at a user-turn boundary", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({ id: String(index), role: "user" as const, text: String(index), timestamp: index }));
    const detail = detailFromSnapshot({
      ...snapshot,
      messages,
    }, undefined, localCursorPolicy);
    expect(detail.messages.map((message) => message.id)).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 20)));
    expect(detail.olderCursor).toBe(asHostTranscriptCursor("local:20"));
    expect(detail.cursorBeforeMessageId).toBe("20");
  });

  it("keeps an adapter cursor when a bounded host snapshot has no local projection", () => {
    const detail = detailFromSnapshot({
      ...snapshot,
      messages: Array.from({ length: 10 }, (_, index) => ({ id: String(index), role: "user" as const, text: String(index), timestamp: index })),
      olderCursor: asHostTranscriptCursor("opaque:adapter-cursor"),
    });
    expect(detail.olderCursor).toBe(asHostTranscriptCursor("opaque:adapter-cursor"));
  });

  it("projects a full snapshot into one shared thread-detail shape", () => {
    const projected = threadDetailFromHostSnapshot({ ...snapshot, olderCursor: asHostTranscriptCursor("opaque:cursor"), cursorBeforeMessageId: "1" });
    expect(projected).toMatchObject({
      sessionId: "session",
      messages: snapshot.messages,
      olderCursor: asHostTranscriptCursor("opaque:cursor"),
      cursorBeforeMessageId: "1",
    });
    expect(projected).not.toHaveProperty("models");
  });

  it("deduplicates explicit and legacy cursor boundaries without inspecting cursor values", () => {
    const explicit = asHostTranscriptCursor("provider::opaque/20");
    const direct = asHostTranscriptCursor("provider::opaque/other");
    expect(normalizeTranscriptCursorBoundaries(
      [{ messageId: "first", cursor: explicit }],
      "first",
      direct,
    )).toEqual([{ messageId: "first", cursor: explicit }]);
    expect(normalizeTranscriptCursorBoundaries(undefined, "first", direct)).toEqual([
      { messageId: "first", cursor: direct },
    ]);
  });

  it("does not infer older turns from an offset when only orphan activities precede the window", () => {
    const messages = [
      { id: "user", role: "user" as const, text: "hello", timestamp: 5 },
      { id: "answer", role: "assistant" as const, text: "world", timestamp: 6 },
    ];
    const detail = detailFromSnapshot({
      ...snapshot,
      messages,
    });
    expect(detail.messages.map((message) => message.id)).toEqual(["user", "answer"]);
    expect(detail.olderCursor).toBeUndefined();
    expect(detail.hasMore).toBe(false);
  });

  it("keeps an unavailable window limited instead of inventing a local end cursor", () => {
    const detail = detailFromSnapshot({
      ...snapshot,
      messages: Array.from({ length: 160 }, (_, index) => ({
        id: `message-${index}`,
        role: "user" as const,
        text: String(index),
        timestamp: index,
      })),
      historyCompleteness: "unknown",
    }, undefined, localCursorPolicy);
    expect(detail.messages).toHaveLength(10);
    expect(detail.olderCursor).toBeUndefined();
    expect(detail.hasMore).toBe(false);
    expect(detail.historyCompleteness).toBe("unknown");
  });

  it("does not turn a cursor-less has-more claim into a false end", () => {
    const detail = detailFromSnapshot({ ...snapshot, historyCompleteness: "has-more" });
    expect(detail.historyCompleteness).toBe("unknown");
  });

  it.each([
    ["complete with cursor", { hasMore: false, olderCursor: "4", historyCompleteness: "complete" }],
    ["complete with has-more", { hasMore: true, olderCursor: "4", historyCompleteness: "complete" }],
    ["has-more without cursor", { hasMore: true, historyCompleteness: "has-more" }],
    ["has-more without flag", { hasMore: false, olderCursor: "4", historyCompleteness: "has-more" }],
    ["unknown with cursor", { hasMore: false, olderCursor: "4", historyCompleteness: "unknown" }],
  ])("rejects contradictory transcript-page metadata: %s", (_label, page) => {
    expect(isHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "transcript-page",
      page: { sessionId: "session", messages: [], ...page },
    })).toBe(false);
  });

  it.each([
    ["complete with cursor", { hasMore: false, olderCursor: "4", historyCompleteness: "complete" }],
    ["complete with has-more", { hasMore: true, olderCursor: "4", historyCompleteness: "complete" }],
    ["has-more without cursor", { hasMore: true, historyCompleteness: "has-more" }],
    ["has-more without flag", { hasMore: false, olderCursor: "4", historyCompleteness: "has-more" }],
    ["unknown with cursor", { hasMore: false, olderCursor: "4", historyCompleteness: "unknown" }],
  ])("rejects contradictory thread-detail metadata: %s", (_label, detail) => {
    expect(isHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "thread-detail",
      detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [], ...detail },
    })).toBe(false);
  });

  it.each([
    ["complete", { hasMore: false, historyCompleteness: "complete" }],
    ["has-more", { hasMore: true, olderCursor: "4", historyCompleteness: "has-more" }],
    ["unknown", { hasMore: false, historyCompleteness: "unknown" }],
  ])("accepts an internally consistent transcript-page tuple: %s", (_label, page) => {
    expect(isHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "transcript-page",
      page: { sessionId: "session", messages: [], ...page },
    })).toBe(true);
  });

  it("rejects a non-opaque cursor object at the desktop protocol seam", () => {
    expect(isHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "transcript-page",
      page: { sessionId: "session", messages: [], hasMore: true, olderCursor: { kind: "bridge", value: "4" } },
    })).toBe(false);
  });

  it.each(["transcriptMessageIndexes", "messagesOffset"])("rejects provider coordinates at the desktop protocol seam: %s", (field) => {
    expect(isHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "transcript-page",
      page: { sessionId: "session", messages: [], hasMore: false, [field]: [0] },
    })).toBe(false);
  });

  it("preserves the runtime image capability in the catalog", () => {
    expect(catalogFromSnapshot(snapshot).supportsImageInput).toBe(true);
  });
});
