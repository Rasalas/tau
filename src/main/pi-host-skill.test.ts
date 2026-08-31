import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiComposerCommand } from "../shared/contracts.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";

const commands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill", description: "Test-driven development" }];

function localHost(adapter: AgentRuntimeAdapter) {
  const emitted: unknown[] = [];
  const prompt = vi.fn(async () => undefined);
  const steer = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const session = {
    sessionId: "session",
    sessionName: undefined as string | undefined,
    sessionFile: "/tmp/session.jsonl",
    messages: [],
    model: { provider: "anthropic", id: "model" },
    isStreaming: false,
    isIdle: false,
    settingsManager: { getEnableSkillCommands: () => true },
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getPrompts: () => ({ prompts: [] }),
      getSkills: () => ({ skills: [{ name: "tdd", description: "Test-driven development" }] }),
    },
    sessionManager: {
      entries: [] as unknown[],
      getBranch() { return this.entries; },
      appendCustomEntry(customType: string, data: unknown) {
        this.entries.push({ type: "custom", customType, data });
        return `marker-${this.entries.length}`;
      },
    },
    prompt,
    steer,
    followUp,
  };
  const thread = {
    session,
    sessionId: "session",
    cwd: "/repo",
    sessionFile: "/tmp/session.jsonl",
    runtimeAdapter: adapter,
    pendingClientMessageIds: [] as string[],
    inFlightClientMessageIds: new Set<string>(),
    adapterQueue: Promise.resolve(),
    adapterMessages: [],
    adapterStreaming: false,
  };
  const host = new PiHost("/repo", (event) => emitted.push(event), {} as never, true, false, { runtimeAdapter: adapter });
  const internals = host as unknown as {
    threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
    branchFor: () => undefined;
    publishThreadShellSoon: () => void;
  };
  internals.branchFor = () => undefined;
  internals.publishThreadShellSoon = () => undefined;
  return { host, session, thread, internals, emitted };
}

async function adopt(host: ReturnType<typeof localHost>): Promise<void> {
  await host.internals.threads.adopt({
    sessionId: host.thread.sessionId,
    cwd: host.thread.cwd,
    runtime: host.thread,
    isolation: "in-process",
  });
  host.internals.threads.setActive(host.thread.sessionId);
}

describe("PiHost skill delivery", () => {
  it("maps bridge messages through the attached Pi runtime adapter", () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      bridgeSnapshot: PiBridgeSnapshot;
      bridgeHostSnapshot(): HostSnapshot;
    };
    internals.bridgeSnapshot = {
      sessionId: "bridge",
      sessionFile: "/tmp/bridge.jsonl",
      cwd: "/repo",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "$tdd fix it" }],
        timestamp: 1,
      }],
      isStreaming: false,
      model: { provider: "anthropic", id: "model" },
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      composerCommands: commands,
    };

    expect(internals.bridgeHostSnapshot().messages[0]).toMatchObject({
      text: "fix it",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd fix it" },
    });
  });

  it("normalizes local delivery through the explicit Pi adapter", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    await adopt(fixture);
    await fixture.host.prompt("$tdd fix it", [], "session");
    expect(fixture.session.prompt).toHaveBeenCalledWith("/skill:tdd fix it", expect.objectContaining({ images: [] }));
  });

  it("persists the client id marker next to the Pi user turn", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    await adopt(fixture);
    await fixture.host.prompt("$tdd fix it", [], "session", "request-42");
    expect(fixture.session.sessionManager.entries).toContainEqual({
      type: "custom",
      customType: "tau-client-message",
      data: { clientMessageId: "request-42" },
    });
  });

  it("keeps a started marker through inner settlement until the user message ends", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    await adopt(fixture);
    const hostInternals = fixture.host as unknown as {
      appendClientMessageMarker(thread: unknown, clientMessageId: string): boolean;
      handleSessionEvent(event: unknown, thread: unknown, sessionId: string, cwd: string): void;
    };
    expect(hostInternals.appendClientMessageMarker(fixture.thread, "request-in-flight")).toBe(true);

    hostInternals.handleSessionEvent({ type: "agent_settled" }, fixture.thread, "session", "/repo");
    expect(fixture.session.sessionManager.entries).not.toContainEqual(expect.objectContaining({ customType: "tau-client-message-cancel" }));

    const userMessage = { role: "user", content: [{ type: "text", text: "keep tracking this" }], timestamp: 4 };
    hostInternals.handleSessionEvent({ type: "message_start", message: userMessage }, fixture.thread, "session", "/repo");
    expect(userMessage).toHaveProperty("clientMessageId", "request-in-flight");
    fixture.session.sessionManager.entries.push({ type: "message", id: "user-entry", message: userMessage });
    hostInternals.handleSessionEvent({ type: "message_end", message: userMessage }, fixture.thread, "session", "/repo");

    fixture.session.isIdle = true;
    hostInternals.handleSessionEvent({ type: "agent_settled" }, fixture.thread, "session", "/repo");
    expect(fixture.session.sessionManager.entries).not.toContainEqual(expect.objectContaining({ customType: "tau-client-message-cancel" }));
    expect(fixture.emitted).toContainEqual(expect.objectContaining({
      type: "user-message",
      message: expect.objectContaining({ clientMessageId: "request-in-flight" }),
    }));
  });

  it("normalizes local delivery through an explicit Claude Code adapter, not model.provider", async () => {
    const transport = { sendPrompt: vi.fn(async () => ({ assistantText: "Done" })) };
    const adapter: AgentRuntimeAdapter = { id: "claude-code", capabilities: { skillInvocationDialect: "claude-code" }, transport };
    const fixture = localHost(adapter);
    await adopt(fixture);
    await fixture.host.prompt("$tdd fix it", [], "session");
    expect(fixture.session.prompt).not.toHaveBeenCalled();
    expect(transport.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ text: "/tdd fix it", sessionId: "session" }));
  });

  it("passes prompt, steer, follow-up, and new-session intent raw to the runtime owner", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false, {
      runtimeAdapter: { id: "pi", capabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities },
    });
    const command = vi.fn(async () => undefined);
    const internals = host as unknown as {
      bridge: { command: typeof command };
      bridgeSnapshot: { sessionId: string };
    };
    internals.bridge = { command };
    internals.bridgeSnapshot = { sessionId: "bridge" };

    await host.prompt("$tdd fix it", [], "bridge");
    await host.steer("$tdd steer it", [], "bridge");
    await host.followUp("$tdd follow it", [], "bridge");
    await host.newSession("$tdd start it");
    expect(command.mock.calls).toEqual([
      [{ command: "prompt", text: "$tdd fix it" }],
      [{ command: "prompt", text: "$tdd steer it", deliverAs: "steer" }],
      [{ command: "prompt", text: "$tdd follow it", deliverAs: "followUp" }],
      [{ command: "new_session", initialPrompt: "$tdd start it" }],
    ]);
  });

  it("formats the bridge's full normalized transcript instead of trusting raw markdown", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const command = vi.fn(async (request: { command: string }) => request.command === "export_markdown"
      ? {
        title: "Visible title",
        cwd: "/repo",
        sessionId: "bridge",
        messages: [
          // The real bridge has already removed the runtime wrapper. The host
          // must format this data without parsing visible `$tdd` text again.
          { role: "user", content: [{ type: "text", text: "$tdd is literal here\n\nFix **the parser**" }] },
          { role: "assistant", content: [{ type: "text", text: "Done" }] },
        ],
      }
      : undefined);
    const internals = host as unknown as {
      bridge: { command: typeof command };
      bridgeSnapshot: PiBridgeSnapshot;
    };
    internals.bridge = { command };
    internals.bridgeSnapshot = {
      sessionId: "bridge",
      sessionFile: "/tmp/bridge.jsonl",
      cwd: "/repo",
      messages: [],
      isStreaming: false,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      composerCommands: commands,
    };

    const markdown = await host.exportThreadMarkdown("bridge");
    expect(markdown).toContain("Fix **the parser**");
    expect(markdown).toContain("$tdd is literal here");
    expect(markdown).not.toContain("<skill");
    expect(markdown).not.toContain("location=");
  });

  it("formats the local full transcript from normalized visible user messages", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    fixture.session.sessionManager.entries = [
      { type: "message", id: "user", message: {
        role: "user",
        content: [{ type: "text", text: `<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected body\n</skill>\n\nReview the parser` }],
        timestamp: 1,
      } },
      { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 } },
    ];
    await adopt(fixture);

    const markdown = await fixture.host.exportThreadMarkdown("session");
    expect(markdown).toContain("Review the parser");
    expect(markdown).not.toContain("<skill");
    expect(markdown).not.toContain("Injected body");
    expect(markdown).not.toContain("location=");
  });
});
