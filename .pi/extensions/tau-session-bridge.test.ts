import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPiBridge, PiBridgeClient } from "../../src/main/pi-bridge-client.js";
import type { PiBridgeDescriptor } from "../../src/shared/pi-bridge-protocol.js";
import tauSessionBridge from "./tau-session-bridge.js";

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
    // The real Pi promise resolves after the run settles.
    sendUserMessage: vi.fn(() => new Promise<void>(() => {})),
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

  it("removes a complete wrapper from export even after its skill is unavailable", async () => {
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
    expect(exported).toContain("Keep the request");
    expect(exported).not.toContain("<skill");
    expect(exported).not.toContain("SECRET BODY");
    expect(exported).not.toContain("location=");
  });

  it("cancels a failed bridge request before the next message can claim its id", async () => {
    const bridge = fakeBridge();
    bridge.pi.sendUserMessage = vi.fn(async () => {
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

    await expect(client.command({ command: "prompt", text: "$tdd failed", clientMessageId: "failed-request" })).resolves.toMatchObject({ accepted: true });
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

  it("keeps a started request tracked when Pi rejects before message_end", async () => {
    const bridge = fakeBridge();
    let rejectSend!: (error: Error) => void;
    bridge.pi.sendUserMessage = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
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

    rejectSend(new Error("runtime failed after message_start"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(bridge.context.sessionManager.getBranch()).toContainEqual({
      type: "custom",
      customType: "tau-client-message-cancel",
      data: { clientMessageId: "started-request" },
    });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ type: "user_message_failed", clientMessageId: "started-request" }),
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
