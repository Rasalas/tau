import { describe, expect, it } from "vitest";
import {
  bridgeTranscriptPage,
  BRIDGE_MAX_RECORD_BYTES,
  BRIDGE_MAX_TRANSCRIPT_BYTES,
  BRIDGE_MAX_TRANSCRIPT_RECORDS,
  boundedBridgePayload,
  boundedBridgeValue,
} from "./bridge-transcript-pager.js";

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("bridge transcript paging", () => {
  it("keeps the cursor in mapped transcript space while carrying tool records", () => {
    const records = Array.from({ length: 60 }, (_, index) => [
      { role: "user", content: `question ${index}`, tauEntryId: `user-${index}` },
      { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], tauEntryId: `assistant-${index}` },
      { role: "toolResult", toolCallId: `call-${index}`, content: `result ${index}` },
    ]).flat();

    const newest = bridgeTranscriptPage(records);
    expect(newest.page.messages).toHaveLength(80);
    expect(newest.page.olderCursor).toBe("40");
    expect(newest.activityMessages.some((record) => (record as { role?: string }).role === "toolResult")).toBe(true);

    const older = bridgeTranscriptPage(records, newest.page.olderCursor);
    expect(older.page.messages).toHaveLength(40);
    expect(older.page.messages[0]).toMatchObject({ tauEntryId: "user-0" });
    expect(older.page.hasMore).toBe(false);
  });

  it("bounds a tool-heavy turn by records and bytes without dropping its anchor", () => {
    const records: unknown[] = [
      { role: "user", content: "inspect", tauEntryId: "user" },
      { role: "assistant", content: [{ type: "text", text: "done" }], tauEntryId: "assistant" },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        role: "toolResult",
        toolCallId: `tool-${index}`,
        content: "x".repeat(8_192),
      })),
    ];
    const result = bridgeTranscriptPage(records);
    const payload = { messages: result.page.messages, activityMessages: result.activityMessages };
    expect(result.page.messages.map((message) => (message as { tauEntryId?: string }).tauEntryId))
      .toEqual(["user", "assistant"]);
    expect(result.activityMessages.length).toBeLessThanOrEqual(BRIDGE_MAX_TRANSCRIPT_RECORDS + 1);
    expect(result.activityMessages.every((message) => encodedBytes(message) <= BRIDGE_MAX_RECORD_BYTES
      || (message as { type?: string }).type === "tau-bridge-truncated")).toBe(true);
    expect(encodedBytes(payload)).toBeLessThan(BRIDGE_MAX_TRANSCRIPT_BYTES);
  });

  it("keeps both visible boundaries when hidden tool output alone exceeds the page budget", () => {
    const records: unknown[] = [
      { role: "user", content: "inspect", tauEntryId: "user" },
      { role: "assistant", content: [{ type: "text", text: "done" }], tauEntryId: "assistant" },
      ...Array.from({ length: 200 }, (_, index) => ({
        role: "toolResult",
        toolCallId: `tool-${index}`,
        content: "x".repeat(256 * 1024),
      })),
    ];
    const result = bridgeTranscriptPage(records);
    expect(result.page.messages.map((message) => (message as { tauEntryId?: string }).tauEntryId))
      .toEqual(["user", "assistant"]);
    expect(encodedBytes({ messages: result.page.messages, activityMessages: result.activityMessages }))
      .toBeLessThan(BRIDGE_MAX_TRANSCRIPT_BYTES);
  });

  it("keeps a full 160-record page addressable after bridge transport bounding", () => {
    const records = Array.from({ length: 40 }, (_, index) => [
      { role: "user", content: `question ${index}`, tauEntryId: `user-${index}` },
      ...Array.from({ length: 3 }, (_, retry) => ({
        role: "assistant",
        content: [{ type: "text", text: `answer ${index}.${retry}` }],
        tauEntryId: `assistant-${index}-${retry}`,
      })),
    ]).flat();

    const newest = bridgeTranscriptPage(records);
    expect(newest.page.messages).toHaveLength(BRIDGE_MAX_TRANSCRIPT_RECORDS);
    const transported = boundedBridgeValue(newest.page);
    expect(transported.messages).toHaveLength(BRIDGE_MAX_TRANSCRIPT_RECORDS);
    expect(transported.olderCursor).toBeUndefined();
    expect(transported.hasMore).toBe(false);
  });

  it("keeps the bridge snapshot shape while compacting an oversized extension payload", () => {
    const payload = boundedBridgePayload({
      sessionId: "session",
      messages: Array.from({ length: 160 }, () => ({ role: "assistant", content: "x".repeat(32 * 1024) })),
      models: Array.from({ length: 64 }, () => ({ provider: "provider", id: "model", name: "x".repeat(8 * 1024) })),
      extensionData: Array.from({ length: 160 }, () => "x".repeat(32 * 1024)),
    }, 256 * 1024);
    expect(encodedBytes(payload)).toBeLessThanOrEqual(256 * 1024);
    expect(Array.isArray((payload as { messages?: unknown }).messages)).toBe(true);
  });

  it("keeps a hundred tool pairs complete even when raw activity records are capped", () => {
    const records: unknown[] = [
      { role: "user", content: "inspect", tauEntryId: "user", timestamp: 1 },
      ...Array.from({ length: 100 }, (_, index) => [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `file-${index}.ts` } }],
          timestamp: index * 2 + 2,
        },
        {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "read",
          content: `result-${index}`,
          isError: false,
          timestamp: index * 2 + 3,
        },
      ]).flat(),
      { role: "assistant", content: [{ type: "text", text: "done" }], tauEntryId: "assistant", timestamp: 203 },
    ];

    const result = bridgeTranscriptPage(records);
    expect(result.activityMessages).toHaveLength(BRIDGE_MAX_TRANSCRIPT_RECORDS + 1);
    expect(result.activityMessages.at(-1)).toMatchObject({ type: "tau-bridge-truncated" });
    expect(result.turnActivityHistoryComplete).toBe(true);
    expect(result.turnActivityHistory).toHaveLength(1);
    expect(result.turnActivityHistory[0]?.status).toBe("completed");
    expect(result.turnActivityHistory[0]?.tools).toHaveLength(100);
    expect(result.turnActivityHistory[0]?.tools.map((tool) => tool.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `call-${index}`),
    );
    expect(result.turnActivityHistory[0]?.tools.every((tool) => tool.status === "done")).toBe(true);
  });

  it("marks an 131084-byte bridge preview as clipped while retaining full-read availability", () => {
    const suffix = "\nFULL-SUFFIX";
    const output = `${"x".repeat(131084 - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
    const result = bridgeTranscriptPage([
      { role: "user", content: "inspect", tauEntryId: "user", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "large-call", name: "read", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "large-call", content: output, isError: false, timestamp: 3 },
    ]);
    const tool = result.turnActivityHistory[0]?.tools[0];
    expect(tool?.output).not.toContain("FULL-SUFFIX");
    expect(tool).toMatchObject({ outputTruncated: true, fullOutputAvailable: true });
  });

  it("keeps the mapped page and duplicated activity payload below one byte budget", () => {
    const records = Array.from({ length: 40 }, (_, index) => [
      { role: "user", content: `question ${index}`, tauEntryId: `user-${index}` },
      ...Array.from({ length: 4 }, (_, retry) => ({
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(80_000) }],
        tauEntryId: `assistant-${index}-${retry}`,
      })),
    ]).flat();
    const result = bridgeTranscriptPage(records);
    expect(encodedBytes({ messages: result.page.messages, activityMessages: result.activityMessages }))
      .toBeLessThan(BRIDGE_MAX_TRANSCRIPT_BYTES);
    expect(result.page.hasMore).toBe(true);
    const next = bridgeTranscriptPage(records, result.page.olderCursor);
    expect(next.page.messages.length).toBeGreaterThan(0);
  });
});
