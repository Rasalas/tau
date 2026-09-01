import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findPiBridge, PiBridgeClient } from "../../src/main/pi-bridge-client.js";
import type { PiBridgeDescriptor } from "../../src/shared/pi-bridge-protocol.js";
import tauSessionBridge, {
  bridgeNewSessionCommand,
  buildTranscriptView,
  createNewSessionRequestTracker,
  InvalidBridgeTranscriptCursorError,
  PI_BRIDGE_SUPPORTS_IMAGE_INPUT,
  BridgeClientTurnLedger,
  bridgeSnapshotMessages,
  decorateBridgeUserMessage,
  toolOutputPageForMessages,
} from "./tau-session-bridge.js";
import { createNewThreadRequestId } from "../../src/shared/contracts.js";

const branch = Array.from({ length: 25 }, (_, turn) => [
  { role: "user", text: `request ${turn}` },
  { role: "assistant", text: `answer ${turn}` },
]).flat();

describe("Tau bridge transcript cursor validation", () => {
  it.each([
    ["negative", "-1"],
    ["malformed", "not-a-cursor"],
    ["stale", String(branch.length + 1)],
    ["unsafe integer", "9007199254740992"],
  ])("rejects %s cursors before paging", (_label, cursor) => {
    try {
      buildTranscriptView(branch, { kind: "older-page", turnLimit: 20, cursor });
      throw new Error("expected cursor validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidBridgeTranscriptCursorError);
      expect((error as InvalidBridgeTranscriptCursorError).code).toBe("INVALID_BRIDGE_TRANSCRIPT_CURSOR");
    }
  });

  it("accepts the exact branch length and returns a deterministic bounded page", () => {
    const view = buildTranscriptView(branch, { kind: "older-page", turnLimit: 20, cursor: String(branch.length) });
    expect(view.visibleMessages.filter((message) => message.role === "user")).toHaveLength(20);
    expect(view.visibleMessages).toHaveLength(40);
    expect(view.hasMore).toBe(true);
    expect(view.olderCursor).toBe("10");
  });
});

describe("Tau bridge tool-output read seam", () => {
  it("returns the durable output in bounded pages", () => {
    const output = `${"x".repeat(128 * 1024)}\nfinal line`;
    const messages = [{ role: "toolResult", toolCallId: "call", content: output }];
    const first = toolOutputPageForMessages(messages, "call");
    expect(first?.offset).toBe(0);
    expect(first?.nextOffset).toBeDefined();
    expect(first?.totalBytes).toBe(Buffer.byteLength(output, "utf8"));

    let offset = first?.offset ?? 0;
    let combined = "";
    let page = first;
    while (page) {
      combined += page.output;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
      page = toolOutputPageForMessages(messages, "call", offset);
    }
    expect(combined).toBe(output);
    expect(toolOutputPageForMessages(messages, "missing")).toBeUndefined();
  });

  it("keeps the suffix reachable beyond the former eight MiB read ceiling", () => {
    const output = `${"x".repeat(8 * 1024 * 1024 + 17)}\nFULL-SUFFIX`;
    const messages = [{ role: "toolResult", toolCallId: "large-call", content: output }];
    let offset = 0;
    let combined = "";
    for (;;) {
      const page = toolOutputPageForMessages(messages, "large-call", offset);
      expect(page).toBeDefined();
      combined += page?.output ?? "";
      if (page?.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(combined).toBe(output);
    expect(combined.endsWith("FULL-SUFFIX")).toBe(true);
  });
});

describe("Tau Pi bridge capability", () => {
  it("declares that the bridge cannot send image prompt input", () => {
    expect(PI_BRIDGE_SUPPORTS_IMAGE_INPUT).toBe(false);
  });

  it("keeps a ready request token until the exact host acknowledgement", () => {
    const tracker = createNewSessionRequestTracker();
    const requestId = createNewThreadRequestId("request-lifecycle");
    const foreignId = createNewThreadRequestId("request-foreign");
    const sessionId = "session-new";
    const bridgeEpoch = "epoch-new";

    tracker.begin(requestId);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(requestId, sessionId, bridgeEpoch)).toBe(false);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    tracker.markReady(requestId, sessionId, bridgeEpoch);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(foreignId, sessionId, bridgeEpoch)).toBe(false);
    expect(tracker.acknowledge(requestId, sessionId, "stale-epoch")).toBe(false);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(requestId, sessionId, bridgeEpoch)).toBe(true);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(requestId, sessionId, bridgeEpoch)).toBe(true);
    expect(tracker.acknowledge(requestId, "other-session", bridgeEpoch)).toBe(false);
    tracker.markReady(requestId, sessionId, "reconnected-epoch");
    expect(tracker.acknowledge(requestId, sessionId, "reconnected-epoch")).toBe(true);
    tracker.begin(foreignId);
    expect(tracker.requestIdForSnapshot()).toBe(foreignId);
    expect(tracker.abort(foreignId, sessionId, bridgeEpoch)).toBe(true);
  });

  it("routes session creation through the registered command boundary", () => {
    expect(bridgeNewSessionCommand()).toBe("/tau-bridge-new");
    expect(bridgeNewSessionCommand("hello / world")).toBe(
      `/tau-bridge-new ${Buffer.from(JSON.stringify("hello / world"), "utf8").toString("base64url")}`,
    );
    expect(bridgeNewSessionCommand("hello", createNewThreadRequestId("request-1"))).toBe(
      `/tau-bridge-new ${Buffer.from(JSON.stringify({ initialPrompt: "hello", requestId: "request-1" }), "utf8").toString("base64url")}`,
    );
  });

  it("passes the request token through the registered Pi command handler", async () => {
    const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> }>();
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<void> }) {
        commands.set(name, command);
      },
      on() {},
    };
    tauSessionBridge(pi as never);
    const requestId = createNewThreadRequestId("request-handler");
    const sendUserMessage = vi.fn();
    const newSession = vi.fn(async (options: { withSession?: (session: { sendUserMessage: typeof sendUserMessage }) => Promise<void> }) => {
      await options.withSession?.({ sendUserMessage });
      return { cancelled: false };
    });
    const handler = commands.get("tau-bridge-new")?.handler;
    expect(handler).toBeDefined();

    await handler!(
      Buffer.from(JSON.stringify({ initialPrompt: "hello", requestId }), "utf8").toString("base64url"),
      { newSession } as never,
    );

    expect(newSession).toHaveBeenCalledOnce();
    // Skill-aware delivery must opt into Pi's template expansion. The raw text
    // remains unchanged for ordinary prompts; this flag is the provider-owned
    // boundary that resolves the registered skill command.
    expect(sendUserMessage).toHaveBeenCalledWith("hello", { expandPromptTemplates: true });
  });
});

interface FakeBridge {
  events: Map<string, (event: any, context: any) => unknown>;
  commands: Map<string, (args: string, context: any) => unknown>;
  context: any;
  pi: any;
}

function fakeBridge(): FakeBridge {
  const events = new Map<string, (event: any, context: any) => unknown>();
  const commands = new Map<string, (args: string, context: any) => unknown>();
  const entries: any[] = [];
  const sessionId = `tau-test-${randomUUID()}`;
  const context = {
    mode: "tui",
    cwd: "/tmp/tau-bridge-test",
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getBranch: () => entries,
      getSessionName: () => undefined,
      appendCustomEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
        return `entry-${entries.length}`;
      },
    },
    model: undefined,
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    getContextUsage: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    abort: vi.fn(),
    compact: vi.fn(),
    ui: { notify: vi.fn() },
  };
  const pi = {
    registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => unknown }) => commands.set(name, definition.handler),
    on: (name: string, handler: (event: any, ctx: any) => unknown) => events.set(name, handler),
    getCommands: () => [{ name: "skill:tdd", source: "skill", description: "Test-driven development" }],
    getSessionName: () => undefined,
    getThinkingLevel: () => "off",
    getActiveTools: () => [],
    getAllTools: () => [],
    // Keep a normal prompt in flight until the test emits its message events.
    // The real ExtensionAPI method is a synchronous void dispatch. The
    // authoritative message events below prove persistence separately.
    sendUserMessage: vi.fn(() => undefined),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    setThinkingLevel: vi.fn(),
    setModel: vi.fn(),
    setSessionName: vi.fn(),
  };
  tauSessionBridge(pi as never);
  return { events, commands, context, pi };
}

describe("Tau bridge runtime ownership", () => {
  it("registers nothing when Tau's host already owns the runtime", () => {
    const previous = process.env.TAU_HOST_RUNTIME;
    process.env.TAU_HOST_RUNTIME = "1";
    try {
      const on = vi.fn();
      const addCommand = vi.fn();
      // Loading the bridge here would run a second checkpoint feature against
      // the workspace lease the host already holds for the same turn.
      tauSessionBridge({ on, addCommand } as never);
      expect(on).not.toHaveBeenCalled();
      expect(addCommand).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TAU_HOST_RUNTIME;
      else process.env.TAU_HOST_RUNTIME = previous;
    }
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("Tau session bridge handler", () => {
  it("normalizes a real prompt command and propagates its client id", async () => {
    const bridge = fakeBridge();
    await bridge.events.get("session_start")?.({}, bridge.context);
    const descriptor = await findPiBridge(bridge.context.cwd);
    expect(descriptor).toBeDefined();
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    const frames: unknown[] = [];
    client.subscribe((frame) => frames.push(frame));
    cleanups.push(async () => {
      await bridge.events.get("session_shutdown")?.({}, bridge.context);
      client.close();
    });
    await client.open();
    expect(client.snapshot?.composerCommands?.find((command) => command.source === "skill")?.skillCommand).toBe("/skill:tdd");

    await expect(client.command({ command: "prompt", text: "$tdd fix it", clientMessageId: "request-1" })).resolves.toMatchObject({ accepted: true });
    expect(bridge.pi.sendUserMessage).toHaveBeenCalledWith("/skill:tdd fix it", expect.objectContaining({ expandPromptTemplates: true }));
    expect(bridge.context.sessionManager.getBranch()).toContainEqual(expect.objectContaining({
      type: "custom",
      customType: "tau-client-message",
      data: expect.objectContaining({ clientMessageId: "request-1", fingerprint: expect.any(String) }),
    }));
    const userMessage = { role: "user", content: [{ type: "text", text: "/skill:tdd fix it" }], timestamp: 1 };
    bridge.context.sessionManager.getBranch().push({ type: "message", id: "user", message: userMessage });
    await bridge.events.get("message_start")?.({ message: userMessage }, bridge.context);
    await bridge.events.get("message_end")?.({ message: userMessage }, bridge.context);
    const snapshot = await client.command({ command: "snapshot" }) as { messages: Array<{ clientMessageId?: string }> };
    expect(snapshot.messages.at(-1)?.clientMessageId).toBe("request-1");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ message: expect.objectContaining({ clientMessageId: "request-1" }) }),
    }));
  });

  it("prepares against the live Pi registry and reuses that result for delivery", async () => {
    const bridge = fakeBridge();
    await bridge.events.get("session_start")?.({}, bridge.context);
    const descriptor = await findPiBridge(bridge.context.cwd);
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    cleanups.push(async () => {
      await bridge.events.get("session_shutdown")?.({}, bridge.context);
      client.close();
    });
    await client.open();

    const prepared = await client.command({ command: "prepare_prompt", text: "$tdd --help" }) as {
      visibleText: string;
      runtimeText: string;
      runtimeCapabilities: { skillInvocationDialect: "pi" };
      sourceFingerprint: string;
      skill?: { name: string; command: string; copyText: string };
    };
    expect(prepared).toMatchObject({
      visibleText: "--help",
      runtimeText: "/skill:tdd --help",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd --help" },
    });

    await expect(client.command({ command: "prompt", text: "$tdd --help", prepared, clientMessageId: "prepared-request" })).resolves.toMatchObject({ accepted: true });
    expect(bridge.pi.sendUserMessage).toHaveBeenCalledWith("/skill:tdd --help", expect.objectContaining({ expandPromptTemplates: true }));
  });

  it("returns normalized full-export messages without the expanded wrapper", async () => {
    const bridge = fakeBridge();
    bridge.context.sessionManager.getBranch = () => [
      { type: "message", id: "user", message: {
        role: "user",
        content: [{ type: "text", text: `<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected body\n</skill>\n\nReview the parser` }],
        timestamp: 1,
      } },
      { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 } },
    ];
    await bridge.events.get("session_start")?.({}, bridge.context);
    const descriptor = await findPiBridge(bridge.context.cwd);
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    cleanups.push(async () => {
      await bridge.events.get("session_shutdown")?.({}, bridge.context);
      client.close();
    });
    await client.open();

    const result = await client.command({ command: "export_markdown" }) as { messages: Array<{ content?: Array<{ text?: string }> }> };
    const exported = result.messages.map((message) => message.content?.map((part) => part.text ?? "").join("\n") ?? "").join("\n");
    expect(exported).toContain("Review the parser");
    expect(exported).not.toContain("Injected body");
    expect(exported).not.toContain("/Users/me/.pi/skills");
  });

  it("keeps an unknown complete wrapper lossless in export", async () => {
    const bridge = fakeBridge();
    bridge.context.sessionManager.getBranch = () => [
      { type: "message", id: "user", message: {
        role: "user",
        content: [{ type: "text", text: `<skill name="removed" location="/private/removed/SKILL.md">\nSECRET BODY\n</skill>\n\nKeep the request` }],
        timestamp: 1,
      } },
    ];
    await bridge.events.get("session_start")?.({}, bridge.context);
    const descriptor = await findPiBridge(bridge.context.cwd);
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    cleanups.push(async () => {
      await bridge.events.get("session_shutdown")?.({}, bridge.context);
      client.close();
    });
    await client.open();

    const result = await client.command({ command: "export_markdown" }) as { messages: Array<{ content?: Array<{ text?: string }> }> };
    const exported = result.messages.map((message) => message.content?.map((part) => part.text ?? "").join("\n") ?? "").join("\n");
    expect(exported).toContain('<skill name="removed" location="/private/removed/SKILL.md">');
    expect(exported).toContain("SECRET BODY");
    expect(exported).toContain("Keep the request");
  });

  it("cancels a failed bridge request before the next message can claim its id", async () => {
    const bridge = fakeBridge();
    bridge.pi.sendUserMessage = vi.fn(() => {
      throw new Error(`<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">injected body</skill>`);
    });
    await bridge.events.get("session_start")?.({}, bridge.context);
    const descriptor = await findPiBridge(bridge.context.cwd);
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    const frames: unknown[] = [];
    client.subscribe((frame) => frames.push(frame));
    cleanups.push(async () => {
      await bridge.events.get("session_shutdown")?.({}, bridge.context);
      client.close();
    });
    await client.open();

    await expect(client.command({ command: "prompt", text: "$tdd failed", clientMessageId: "failed-request" })).rejects.toThrow("injected body");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(bridge.context.sessionManager.getBranch()).toContainEqual({
      type: "custom",
      customType: "tau-client-message-cancel",
      data: { clientMessageId: "failed-request" },
    });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ type: "user_message_failed", clientMessageId: "failed-request" }),
    }));
    expect(JSON.stringify(frames)).not.toContain("/Users/me/.pi/skills");
    expect(JSON.stringify(frames)).not.toContain("injected body");

    const nextMessage = { role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 };
    bridge.context.sessionManager.getBranch().push({ type: "message", id: "next", message: nextMessage });
    await bridge.events.get("message_start")?.({ message: nextMessage }, bridge.context);
    expect(nextMessage).not.toHaveProperty("clientMessageId");
  });

  it("keeps an accepted request tracked until Pi's authoritative message event", async () => {
    const bridge = fakeBridge();
    await bridge.events.get("session_start")?.({}, bridge.context);
    const descriptor = await findPiBridge(bridge.context.cwd);
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    const frames: unknown[] = [];
    client.subscribe((frame) => frames.push(frame));
    cleanups.push(async () => {
      await bridge.events.get("session_shutdown")?.({}, bridge.context);
      client.close();
    });
    await client.open();

    await expect(client.command({ command: "prompt", text: "$tdd failed after start", clientMessageId: "started-request" }))
      .resolves.toMatchObject({ accepted: true });
    const userMessage = { role: "user", content: [{ type: "text", text: "/skill:tdd failed after start" }], timestamp: 3 };
    await bridge.events.get("message_start")?.({ message: userMessage }, bridge.context);
    expect(userMessage).toHaveProperty("clientMessageId", "started-request");
    expect(bridge.context.sessionManager.getBranch()).not.toContainEqual(expect.objectContaining({ customType: "tau-client-message-cancel" }));
    expect(frames).not.toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ type: "user_message_failed", clientMessageId: "started-request" }),
    }));
  });

  it("reports a synchronous void-dispatch failure without claiming the prompt was accepted", async () => {
    const bridge = fakeBridge();
    bridge.pi.sendUserMessage = vi.fn(() => { throw new Error("Pi dispatch failed"); });
    await bridge.events.get("session_start")?.({}, bridge.context);
    const descriptor = await findPiBridge(bridge.context.cwd);
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    const frames: unknown[] = [];
    client.subscribe((frame) => frames.push(frame));
    cleanups.push(async () => {
      await bridge.events.get("session_shutdown")?.({}, bridge.context);
      client.close();
    });
    await client.open();

    await expect(client.command({ command: "prompt", text: "$tdd dispatch fails", clientMessageId: "dispatch-failed" }))
      .rejects.toThrow("Pi dispatch failed");
    expect(bridge.context.sessionManager.getBranch()).toContainEqual({
      type: "custom",
      customType: "tau-client-message-cancel",
      data: { clientMessageId: "dispatch-failed" },
    });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ clientMessageId: "dispatch-failed" }),
    }));
  });

  it("cancels an orphaned marker when the bridge is restarted", async () => {
    const bridge = fakeBridge();
    cleanups.push(async () => { await bridge.events.get("session_shutdown")?.({}, bridge.context); });
    await bridge.events.get("session_start")?.({}, bridge.context);
    bridge.context.sessionManager.getBranch().push({
      type: "custom",
      customType: "tau-client-message",
      data: { clientMessageId: "orphaned-request" },
    });

    await bridge.events.get("session_start")?.({}, bridge.context);
    expect(bridge.context.sessionManager.getBranch()).toContainEqual({
      type: "custom",
      customType: "tau-client-message-cancel",
      data: { clientMessageId: "orphaned-request" },
    });
    const descriptor = await findPiBridge(bridge.context.cwd);
    const client = new PiBridgeClient(descriptor as PiBridgeDescriptor);
    cleanups.push(async () => client.close());
    await client.open();
    expect(client.snapshot?.failedClientMessageIds).toContain("orphaned-request");
  });
});

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
    const raw: Record<string, unknown> = {
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
