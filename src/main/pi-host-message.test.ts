import { describe, expect, it } from "vitest";
import type { UiComposerCommand } from "../shared/contracts.js";
import { historyCompletenessForBridgeSnapshot, mapBridgeMessages, mapBridgeTranscriptPageValue, mapMessage } from "./pi-host.js";
import { decodeHostCursor } from "./transcript-cursor.js";
import { createClaudeCodeRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";

const skillCommands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill" }];

describe("Pi message mapping", () => {
  it("keeps user image content for the renderer", () => {
    expect(mapMessage({
      role: "user",
      content: [
        { type: "text", text: "please inspect" },
        { type: "image", mimeType: "image/png", data: "iVBORw==" },
      ],
      timestamp: 1,
    }, 0)).toMatchObject({
      role: "user",
      text: "please inspect",
      images: [{ mimeType: "image/png", data: "iVBORw==" }],
    });
  });

  it("maps bridge records without leaking provider coordinates", () => {
    const mapped = mapBridgeMessages([
      { role: "toolResult", content: "hidden" },
      { role: "user", content: "hello", tauEntryId: "entry-user" },
      { role: "assistant", content: "world", tauEntryId: "entry-assistant" },
    ], 40);
    expect(mapped.map((message) => message.id)).toEqual(["entry-user", "entry-assistant"]);
    expect(mapped).not.toHaveProperty("transcriptMessageIndexes");
  });

  it("rejects an invalid bridge offset instead of guessing a cursor", () => {
    expect(() => mapBridgeMessages([], -1)).toThrow("invalid transcript message offset");
    expect(() => mapBridgeMessages([], "40")).toThrow("invalid transcript message offset");
  });

  it("validates and maps bridge pages at the host seam", () => {
    const page = mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread",
      messages: [
        { role: "toolResult", content: "hidden" },
        { role: "user", content: "hello", tauEntryId: "user" },
      ],
      messagesOffset: 10,
      olderCursor: "provider-token",
      hasMore: true,
    });
    expect(page).toMatchObject({
      sessionId: "thread",
      messages: [{ id: "user" }],
      transcriptWindow: "bounded",
      olderCursor: expect.any(String),
      hasMore: true,
    });
    expect(decodeHostCursor(page.olderCursor)).toEqual({ kind: "bridge", value: "provider-token" });
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread", messages: [], olderCursor: "", hasMore: false,
    })).toThrow("invalid transcript page cursor");
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread", messages: [], hasMore: true,
    })).toThrow("invalid transcript page");
  });

  it.each([
    ["complete with cursor", { olderCursor: "4", hasMore: false, historyCompleteness: "complete" }],
    ["has-more without cursor", { hasMore: true, historyCompleteness: "has-more" }],
    ["unknown with cursor", { olderCursor: "4", hasMore: false, historyCompleteness: "unknown" }],
  ])("rejects contradictory bridge page metadata: %s", (_label, metadata) => {
    expect(() => mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread",
      messages: [],
      ...metadata,
    })).toThrow("invalid transcript page");
  });

  it("marks an unpaged bridge snapshot as unavailable rather than complete", () => {
    expect(historyCompletenessForBridgeSnapshot({
      capabilities: undefined,
      historyCompleteness: "complete",
    })).toBe("unknown");
    expect(historyCompletenessForBridgeSnapshot({
      capabilities: undefined,
    })).toBe("unknown");
  });

  it("uses negotiated paging metadata instead of the legacy cap", () => {
    expect(historyCompletenessForBridgeSnapshot({
      capabilities: { transcriptPaging: true },
      olderCursor: "80",
    })).toBe("has-more");
    expect(historyCompletenessForBridgeSnapshot({
      capabilities: { transcriptPaging: true },
    })).toBe("complete");
  });

  it("keeps contradictory has-more metadata limited when no cursor is available", () => {
    expect(historyCompletenessForBridgeSnapshot({
      capabilities: { transcriptPaging: true },
      historyCompleteness: "has-more",
    })).toBe("unknown");
  });

  it("does not trust a legacy complete claim over the bounded record cap", () => {
    expect(historyCompletenessForBridgeSnapshot({
      capabilities: undefined,
      historyCompleteness: "complete",
    })).toBe("unknown");
  });

  it("normalizes the removed legacy bridge state at the adapter boundary", () => {
    const page = mapBridgeTranscriptPageValue("thread", {
      sessionId: "thread",
      messages: [],
      hasMore: false,
      historyCompleteness: "legacy-truncated",
    });
    expect(page.historyCompleteness).toBe("unknown");
  });

  it("resolves Pi skill envelopes before sending typed UI data to the renderer", () => {
    const message = mapMessage({
      role: "user",
      content: [{ type: "text", text: `<skill name="tdd" location="/tmp/tdd/SKILL.md">\nReferences are relative to /tmp/tdd.\n\nInjected body\n</skill>\n\nFix **the parser**` }],
      timestamp: 1,
    }, 0, { runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER, skillCommands });
    expect(message).toMatchObject({
      role: "user",
      text: "Fix **the parser**",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd Fix **the parser**" },
    });
    expect(message?.text).not.toContain("Injected body");
    expect(message?.text).not.toContain("/tmp/tdd");
    expect(message?.skill?.copyText).not.toContain("Injected body");
    expect(message?.skill?.copyText).not.toContain("/tmp/tdd");
  });

  it("uses the runtime adapter dialect for Claude Code without reading model.provider", () => {
    const claudeCode = createClaudeCodeRuntimeAdapter({ command: "claude-test" });
    const message = mapMessage({
      role: "user",
      content: [{ type: "text", text: "$tdd fix it" }],
      timestamp: 1,
    }, 0, { runtimeAdapter: claudeCode, skillCommands });
    expect(message).toMatchObject({
      text: "fix it",
      skill: { name: "tdd", command: "/tdd", copyText: "/tdd fix it" },
    });
  });

  it("keeps live user events distinct when timestamps collide", () => {
    const first = mapMessage({ role: "user", clientMessageId: "request-a", content: "same", timestamp: 1 }, 0);
    const second = mapMessage({ role: "user", clientMessageId: "request-b", content: "same", timestamp: 1 }, 0);
    expect(first?.id).not.toBe(second?.id);
  });

  it("preserves client turn metadata from a bridge or persisted snapshot", () => {
    expect(mapMessage({
      role: "user",
      content: [{ type: "text", text: "expanded template" }],
      timestamp: 2,
      tauEntryId: "entry",
      clientTurnId: "turn-1",
      clientMessageId: "message-1",
    }, 0)).toMatchObject({
      id: "entry",
      clientTurnId: "turn-1",
      clientMessageId: "message-1",
    });
  });

  it("keeps unknown and malformed wrappers as the original user text", () => {
    const malformed = `<skill name="tdd" location="/tmp/tdd">\nInjected body\n</skill`;
    expect(mapMessage({ role: "user", content: [{ type: "text", text: malformed }] }, 0, {
      runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
      skillCommands,
    })).toMatchObject({ text: malformed });
  });
});
