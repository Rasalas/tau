import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPiBridge, PiBridgeClient } from "../../src/main/pi-bridge-client.js";
import type { PiBridgeDescriptor } from "../../src/shared/pi-bridge-protocol.js";
import tauSessionBridge, {
  bridgeNewSessionCommand,
  buildTranscriptView,
  createNewSessionRequestTracker,
  InvalidBridgeTranscriptCursorError,
  PI_BRIDGE_SUPPORTS_IMAGE_INPUT,
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
