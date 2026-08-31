import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findPiBridge, PiBridgeClient } from "../../src/main/pi-bridge-client.js";
import {
  BridgeClientTurnLedger,
  bridgeSnapshotMessages,
  decorateBridgeUserMessage,
  default as tauSessionBridge,
} from "./tau-session-bridge.ts";

describe("Pi bridge client-turn correlation", () => {
  it.each([
    ["/skill:review", "Expanded review instructions"],
    ["/template:ship", "Expanded template instructions"],
  ])("carries expanded %s identity into a cloned persisted snapshot", (submittedText, expandedText) => {
    const ledger = new BridgeClientTurnLedger();
    const identity = { clientTurnId: `turn-${submittedText}`, clientMessageId: `message-${submittedText}` };
    ledger.enqueue("session", identity, submittedText);
    expect(ledger.size).toBe(1);
    const eventMessage: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: expandedText }],
      timestamp: 42,
    };

    decorateBridgeUserMessage(ledger, eventMessage, "session");
    const snapshot = bridgeSnapshotMessages(ledger, "session", [{
      type: "message",
      id: "entry-42",
      // JSON serialization creates a new object and can drop extension-only
      // fields in older Pi versions. The bounded ledger still recovers it by
      // the observed fingerprint/timestamp and entry ID.
      message: JSON.parse(JSON.stringify({
        role: "user",
        content: [{ type: "text", text: expandedText }],
        timestamp: 42,
      })),
    }]);

    expect(snapshot[0]).toMatchObject({
      tauEntryId: "entry-42",
      tauClientTurnId: identity.clientTurnId,
      tauClientMessageId: identity.clientMessageId,
    });
  });

  it("uses explicit IDs for out-of-order identical prompts and ignores control messages", () => {
    const ledger = new BridgeClientTurnLedger();
    const first = { clientTurnId: "turn-first", clientMessageId: "message-first" };
    const second = { clientTurnId: "turn-second", clientMessageId: "message-second" };
    ledger.enqueue("session", first, "same prompt");
    ledger.enqueue("session", second, "same prompt");

    const secondMessage: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "same prompt" }],
      timestamp: 10,
      tauClientTurnId: second.clientTurnId,
      tauClientMessageId: second.clientMessageId,
    };
    decorateBridgeUserMessage(ledger, secondMessage, "session");
    expect(secondMessage.tauClientTurnId).toBe(second.clientTurnId);

    const control: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "/tau-bridge-new encoded" }],
      timestamp: 11,
    };
    decorateBridgeUserMessage(ledger, control, "session");
    expect(control.tauClientTurnId).toBeUndefined();

    const firstMessage: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "same prompt" }],
      timestamp: 12,
      tauClientTurnId: first.clientTurnId,
      tauClientMessageId: first.clientMessageId,
    };
    decorateBridgeUserMessage(ledger, firstMessage, "session");
    expect(firstMessage.tauClientMessageId).toBe(first.clientMessageId);
  });

  it("does not let an explicit unknown identity consume a pending prompt", () => {
    const ledger = new BridgeClientTurnLedger();
    ledger.enqueue("session", { clientTurnId: "known-turn", clientMessageId: "known-message" }, "same prompt");
    const message: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "same prompt" }],
      timestamp: 43,
      tauClientTurnId: "unknown-turn",
      tauClientMessageId: "known-message",
    };

    decorateBridgeUserMessage(ledger, message, "session");

    expect(message.tauClientTurnId).toBe("unknown-turn");
    const next: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "same prompt" }],
      timestamp: 44,
    };
    decorateBridgeUserMessage(ledger, next, "session");
    expect(next.tauClientTurnId).toBe("known-turn");
  });

  it("treats explicit metadata as authoritative on a reused runtime object", () => {
    const ledger = new BridgeClientTurnLedger();
    const first = { clientTurnId: "first-turn", clientMessageId: "first-message" };
    const second = { clientTurnId: "second-turn", clientMessageId: "second-message" };
    ledger.enqueue("session", first, "first");
    const raw = {
      role: "user",
      content: "first",
      timestamp: 1,
    };
    decorateBridgeUserMessage(ledger, raw, "session");
    ledger.enqueue("session", second, "second");
    Object.assign(raw, second);

    decorateBridgeUserMessage(ledger, raw, "session");

    expect(raw.tauClientTurnId).toBe(second.clientTurnId);
    expect(ledger.size).toBeGreaterThanOrEqual(1);
  });

  it("recovers the identity on a cloned message_end event", () => {
    const ledger = new BridgeClientTurnLedger();
    const identity = { clientTurnId: "cloned-turn", clientMessageId: "cloned-message" };
    ledger.enqueue("session", identity, "submitted prompt");
    const messageStart: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "expanded prompt" }],
      timestamp: 7,
    };
    decorateBridgeUserMessage(ledger, messageStart, "session");

    const messageEnd: Record<string, unknown> = JSON.parse(JSON.stringify(messageStart));
    delete messageEnd.tauClientTurnId;
    delete messageEnd.tauClientMessageId;
    decorateBridgeUserMessage(ledger, messageEnd, "session");

    expect(messageEnd.tauClientTurnId).toBe(identity.clientTurnId);
    expect(messageEnd.tauClientMessageId).toBe(identity.clientMessageId);
  });

  it("recovers a unique expanded prompt when persistence changes its timestamp", () => {
    const ledger = new BridgeClientTurnLedger();
    const identity = { clientTurnId: "timestamp-turn", clientMessageId: "timestamp-message" };
    ledger.enqueue("session", identity, "/skill:review");
    const eventMessage: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "Expanded review instructions" }],
      timestamp: 7,
    };
    decorateBridgeUserMessage(ledger, eventMessage, "session");

    const snapshot = bridgeSnapshotMessages(ledger, "session", [{
      type: "message",
      id: "entry-timestamp",
      message: {
        role: "user",
        content: [{ type: "text", text: "Expanded review instructions" }],
        timestamp: 8,
      },
    }]);

    expect(snapshot[0]).toMatchObject({
      tauClientTurnId: identity.clientTurnId,
      tauClientMessageId: identity.clientMessageId,
    });
  });

  it("keeps the final cloned snapshot correlated until settlement completes", () => {
    const ledger = new BridgeClientTurnLedger();
    const identity = { clientTurnId: "settled-turn", clientMessageId: "settled-message" };
    ledger.enqueue("session", identity, "submitted prompt");
    const eventMessage: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "expanded prompt" }],
      timestamp: 8,
    };
    decorateBridgeUserMessage(ledger, eventMessage, "session");
    const cloned = JSON.parse(JSON.stringify(eventMessage)) as Record<string, unknown>;
    delete cloned.tauClientTurnId;
    delete cloned.tauClientMessageId;

    const snapshot = bridgeSnapshotMessages(ledger, "session", [{ type: "message", id: "entry-8", message: cloned }]);
    expect(snapshot[0]).toMatchObject({ tauClientTurnId: identity.clientTurnId, tauClientMessageId: identity.clientMessageId });

    ledger.settle("session");
    expect(ledger.size).toBe(0);
  });

  it("does not assign a pending prompt to an unrelated older snapshot entry", () => {
    const ledger = new BridgeClientTurnLedger();
    const identity = { clientTurnId: "new-turn", clientMessageId: "new-message" };
    ledger.enqueue("session", identity, "new prompt");

    const snapshot = bridgeSnapshotMessages(ledger, "session", [{
      type: "message",
      id: "old-entry",
      message: { role: "user", content: "old prompt", timestamp: 1 },
    }]);

    expect(snapshot[0]).not.toHaveProperty("tauClientTurnId");
    expect(ledger.size).toBe(1);
  });

  it("never decorates an assistant snapshot with a pending user identity", () => {
    const ledger = new BridgeClientTurnLedger();
    ledger.enqueue("session", { clientTurnId: "turn", clientMessageId: "message" }, "assistant output");
    const snapshot = bridgeSnapshotMessages(ledger, "session", [{
      type: "message",
      id: "assistant-entry",
      message: { role: "assistant", content: "assistant output", timestamp: 2 },
    }]);

    expect(snapshot[0]).not.toHaveProperty("tauClientTurnId");
    expect(ledger.size).toBe(1);
  });

  it("preserves a draft identity across the new-session boundary", () => {
    const ledger = new BridgeClientTurnLedger();
    const draft = { clientTurnId: "turn-draft", clientMessageId: "message-draft" };
    ledger.enqueueAny(draft, "/template:ship");
    const message: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "authoritative template" }],
      timestamp: 100,
    };
    decorateBridgeUserMessage(ledger, message, "new-session");
    expect(message.tauClientTurnId).toBe(draft.clientTurnId);
    expect(ledger.size).toBeGreaterThan(0);
  });

  it("bounds remembered identities and clears settled session state", () => {
    const ledger = new BridgeClientTurnLedger();
    for (let index = 0; index < 1_200; index += 1) {
      ledger.remember(`session-${index % 8}`, {
        role: "user",
        content: `message ${index}`,
        timestamp: index,
      }, {
        clientTurnId: `turn-${index}`,
        clientMessageId: `message-${index}`,
      });
    }

    expect(ledger.size).toBeLessThanOrEqual(1_024);
    ledger.settle("session-1");
    ledger.clear();
    expect(ledger.size).toBe(0);
  });

  it("keeps pending identities bounded across sessions", () => {
    const ledger = new BridgeClientTurnLedger();
    for (let index = 0; index < 2_000; index += 1) {
      ledger.enqueue(`pending-session-${index}`, {
        clientTurnId: `pending-turn-${index}`,
        clientMessageId: `pending-message-${index}`,
      }, `pending ${index}`);
    }

    expect(ledger.size).toBeLessThanOrEqual(1_024);
  });
});

describe("Pi bridge command-to-snapshot integration", () => {
  it("carries expanded commands and out-of-order duplicate identities through the real bridge handler", async () => {
    const sessionId = `bridge-test-${randomUUID()}`;
    const sessionFile = `/tmp/${sessionId}.jsonl`;
    const branch: Array<{ type: string; id: string; message?: Record<string, unknown> }> = [];
    const handlers = new Map<string, Array<(event: Record<string, unknown>, context: ExtensionContext) => unknown>>();
    const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => unknown }>();
    const sent: Array<{ content: unknown; options?: unknown }> = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, context: ExtensionContext) => unknown }) {
        commands.set(name, options);
      },
      on(name: string, handler: (event: Record<string, unknown>, context: ExtensionContext) => unknown) {
        const entries = handlers.get(name) ?? [];
        entries.push(handler);
        handlers.set(name, entries);
      },
      sendUserMessage(content: unknown, options?: unknown) { sent.push({ content, options }); },
      getSessionName: () => undefined,
      getCommands: () => [],
      getThinkingLevel: () => "off",
      getActiveTools: () => [],
      getAllTools: () => [],
      getSessionId: () => sessionId,
    } as unknown as ExtensionAPI;
    const context = {
      mode: "tui",
      cwd: "/tmp/bridge-test",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getBranch: () => branch,
      },
      isIdle: () => true,
      getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
      model: undefined,
      modelRegistry: { getAvailable: () => [] },
    } as unknown as ExtensionContext;
    tauSessionBridge(pi);
    const emit = async (eventName: string, event: Record<string, unknown>) => {
      for (const handler of handlers.get(eventName) ?? []) await handler(event, context);
    };
    await emit("session_start", {});
    const descriptor = await findPiBridge(context.cwd, sessionFile);
    expect(descriptor).toBeDefined();
    const client = new PiBridgeClient(descriptor!);
    try {
      await client.open();
      const expandedCommands = [
        { submitted: "/skill:review", expanded: "Expanded skill instructions", identity: { clientTurnId: "turn-skill", clientMessageId: "message-skill" } },
        { submitted: "/template:ship", expanded: "Expanded template instructions", identity: { clientTurnId: "turn-template", clientMessageId: "message-template" } },
      ];
      for (const [index, item] of expandedCommands.entries()) {
        await client.command({ command: "prompt", text: item.submitted, ...item.identity });
        expect(sent[index]?.content).toBe(item.submitted);
        expect(sent[index]?.options).toMatchObject({ expandPromptTemplates: true });
        const message = { role: "user", content: [{ type: "text", text: item.expanded }], timestamp: index + 1 };
        branch.push({ type: "message", id: `entry-${index}`, message });
        await emit("message_end", { message });
      }

      const duplicateFirst = { clientTurnId: "turn-duplicate-first", clientMessageId: "message-duplicate-first" };
      const duplicateSecond = { clientTurnId: "turn-duplicate-second", clientMessageId: "message-duplicate-second" };
      await client.command({ command: "prompt", text: "same prompt", ...duplicateFirst });
      await client.command({ command: "prompt", text: "same prompt", ...duplicateSecond });
      const secondMessage = {
        role: "user",
        content: [{ type: "text", text: "same prompt" }],
        timestamp: 10,
        tauClientTurnId: duplicateSecond.clientTurnId,
        tauClientMessageId: duplicateSecond.clientMessageId,
      };
      const firstMessage = {
        role: "user",
        content: [{ type: "text", text: "same prompt" }],
        timestamp: 11,
        tauClientTurnId: duplicateFirst.clientTurnId,
        tauClientMessageId: duplicateFirst.clientMessageId,
      };
      branch.push({ type: "message", id: "entry-duplicate-second", message: secondMessage });
      await emit("message_end", { message: secondMessage });
      branch.push({ type: "message", id: "entry-duplicate-first", message: firstMessage });
      await emit("message_end", { message: firstMessage });

      const snapshot = await client.command({ command: "snapshot" }) as { messages: Array<Record<string, unknown>> };
      expect(snapshot.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ tauEntryId: "entry-0", tauClientTurnId: "turn-skill", tauClientMessageId: "message-skill" }),
        expect.objectContaining({ tauEntryId: "entry-1", tauClientTurnId: "turn-template", tauClientMessageId: "message-template" }),
        expect.objectContaining({ tauEntryId: "entry-duplicate-second", tauClientTurnId: duplicateSecond.clientTurnId, tauClientMessageId: duplicateSecond.clientMessageId }),
        expect.objectContaining({ tauEntryId: "entry-duplicate-first", tauClientTurnId: duplicateFirst.clientTurnId, tauClientMessageId: duplicateFirst.clientMessageId }),
      ]));
      expect(commands.has("tau-bridge-new")).toBe(true);
    } finally {
      client.close();
      await emit("session_shutdown", {});
    }
  });
});
