import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiComposerCommand } from "../shared/contracts.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import { prepareSkillPrompt } from "./skill-invocation.js";

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
    abort: vi.fn(async () => undefined),
  };
  const textFromContent = (content: unknown): string => typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n")
      : "";
  const visibleMessage = (entry: any, index: number) => {
    const message = entry?.message ?? entry;
    const text = textFromContent(message?.content);
    const knownSkill = /^<skill\s+name="tdd"[^>]*>[\s\S]*?<\/skill>\s*/u.exec(text);
    const visibleText = knownSkill ? text.slice(knownSkill[0].length) : text;
    return {
      id: entry?.id ?? `${message?.role ?? "message"}-${index}`,
      role: message?.role,
      text: visibleText,
      ...(message?.role === "user" && knownSkill ? {
        skill: { name: "tdd", command: adapter.id === "claude-code" ? "/tdd" : "/skill:tdd", copyText: `${adapter.id === "claude-code" ? "/tdd" : "/skill:tdd"}${visibleText ? ` ${visibleText}` : ""}` },
      } : {}),
      timestamp: message?.timestamp ?? index,
    };
  };
  const thread: any = {
    session,
    threadId: "session",
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
  thread.runtime = { session };
  thread.backend = {
    kind: adapter.id,
    runtimeAdapter: adapter,
    threadId: "session",
    providerSessionId: "session",
    sessionId: "session",
    cwd: "/repo",
    isStreaming: () => session.isStreaming,
    isIdle: () => session.isIdle,
    composerCommands: () => commands,
    sessionFile: () => session.sessionFile,
    sessionName: () => session.sessionName,
    branchEntries: () => session.sessionManager.getBranch(),
    hasMessages: () => session.messages.length > 0 || session.sessionManager.getBranch().some((entry: any) => entry.type === "message"),
    appendCustomEntry: (customType: string, data: unknown) => { session.sessionManager.appendCustomEntry(customType, data); },
    appendMessage: (message: unknown) => { session.sessionManager.entries.push({ type: "message", id: `message-${session.sessionManager.entries.length}`, message }); },
    bind: async () => undefined,
    unbind: () => undefined,
    setLifecycleHooks: () => undefined,
    reload: async () => undefined,
    extensionCount: () => 0,
    isBashRunning: () => false,
    executeBash: async () => ({ output: "", exitCode: 0, cancelled: false, truncated: false }),
    createFork: () => undefined,
    waitForIdle: async () => undefined,
    completeTitle: async () => "Test title",
    modelApi: () => undefined,
    model: () => ({ provider: session.model.provider, id: session.model.id, name: session.model.id }),
    thinkingLevel: () => "off",
    thinkingLevels: () => ["off"],
    activeToolNames: () => [],
    allTools: () => [],
    contextUsage: () => undefined,
    preparePrompt: async (text: string, selectedSkill?: any) => {
      const prepared = prepareSkillPrompt(text, adapter, commands, selectedSkill);
      return {
        tauThreadId: "session",
        providerSessionId: "session",
        sessionId: "session",
        backendKind: adapter.id,
        runtimeCapabilities: adapter.capabilities,
        visibleText: prepared.text,
        runtimeText: prepared.runtimeText,
        ...(prepared.skill ? { skill: prepared.skill } : {}),
        sourceFingerprint: clientMessageFingerprint(text, ["tdd"]),
      };
    },
    transcript: async () => thread.adapterMessages.length > 0
      ? thread.adapterMessages
      : session.sessionManager.getBranch().flatMap((entry: any, index: number) => entry.type === "message" ? [visibleMessage(entry, index)] : []),
    detail: async () => ({
      backendKind: adapter.id,
      threadId: "session",
      providerSessionId: "session",
      sessionId: "session",
      cwd: "/repo",
      title: session.sessionName,
      messages: await thread.backend.transcript(),
      isStreaming: false,
      activeTools: [],
      catalog: {
        models: adapter.id === "pi" ? [{ provider: session.model.provider, id: session.model.id, name: session.model.id }] : [],
        model: adapter.id === "pi" ? { provider: session.model.provider, id: session.model.id, name: session.model.id } : undefined,
        runtimeCapabilities: adapter.capabilities,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        allTools: [],
        composerCommands: commands,
      },
    }),
    prompt: async (input: { text: string; delivery: "prompt" | "steer" | "followUp"; prepared?: { runtimeText: string }; promptOptions?: unknown; images?: unknown }) => {
      if (adapter.id === "pi") {
        const runtimeText = input.prepared?.runtimeText
          ?? prepareSkillPrompt(input.text, adapter, commands).runtimeText;
        const invoke = session[input.delivery === "prompt" ? "prompt" : input.delivery === "steer" ? "steer" : "followUp"] as (text: string, options?: unknown) => Promise<unknown>;
        await invoke(
          runtimeText,
          input.promptOptions ?? input.images,
        );
        return {};
      }
      await adapter.transport.sendPrompt({
        cwd: "/repo",
        tauThreadId: "session",
        sessionId: "session",
        text: input.prepared?.runtimeText
          ?? (input.text.startsWith("$tdd ") ? `/tdd ${input.text.slice("$tdd ".length)}` : input.text),
        delivery: input.delivery,
        permissionPolicy: { permissionMode: "auto", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] },
      });
      return {};
    },
    abort: async () => { if (adapter.id === "claude-code") await adapter.transport.abort?.("session"); },
  };
  const host = new PiHost("/repo", (event) => emitted.push(event), {} as never, false, false, { runtimeAdapter: adapter });
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
    threadId: host.thread.threadId,
    cwd: host.thread.cwd,
    runtime: host.thread,
    isolation: "in-process",
  });
  host.internals.threads.setActive(host.thread.threadId);
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
      supportsImageInput: false,
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
    expect(fixture.session.sessionManager.entries).toContainEqual(expect.objectContaining({
      type: "custom",
      customType: "tau-client-message",
      data: expect.objectContaining({ clientMessageId: "request-42", fingerprint: expect.any(String) }),
    }));
  });

  it("keeps a started marker through inner settlement until the user message ends", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    await adopt(fixture);
    const hostInternals = fixture.host as unknown as {
      appendClientMessageMarker(thread: unknown, clientMessageId: string, correlationText?: string): boolean;
      handleSessionEvent(event: unknown, thread: unknown, sessionId: string, cwd: string): void;
    };
    expect(hostInternals.appendClientMessageMarker(fixture.thread, "request-in-flight", "keep tracking this")).toBe(true);

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
    expect(transport.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      text: "/tdd fix it",
      sessionId: "session",
      permissionPolicy: { permissionMode: "auto", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] },
    }));
  });

  it("reprojects supplied skill catalogs through the selected Claude dialect", () => {
    const adapter: AgentRuntimeAdapter = {
      id: "claude-code",
      capabilities: { skillInvocationDialect: "claude-code" },
      transport: { sendPrompt: vi.fn(async () => ({})) },
    };
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, {
      runtimeAdapter: adapter,
      runtimeCommands: [{ ...commands[0], skillCommand: "/skill:tdd" }],
    });
    const claudeCommands = (host as unknown as { claudeComposerCommands(cwd: string): UiComposerCommand[] }).claudeComposerCommands("/repo");
    expect(claudeCommands).toEqual([{ ...commands[0], skillCommand: "/tdd" }]);
  });

  it("routes abort through the selected adapter and never calls Pi abort", async () => {
    let rejectPrompt!: (error: Error) => void;
    const transport = {
      sendPrompt: vi.fn(() => new Promise<{ assistantText?: string }>((_resolve, reject) => { rejectPrompt = reject; })),
      abort: vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        rejectPrompt(error);
      }),
    };
    const adapter: AgentRuntimeAdapter = { id: "claude-code", capabilities: { skillInvocationDialect: "claude-code" }, transport };
    const fixture = localHost(adapter);
    await adopt(fixture);

    const pending = fixture.host.prompt("keep running", [], "session", "request-abort");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.host.abort("session");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.abort).toHaveBeenCalledWith("session");
    expect(fixture.session.abort).not.toHaveBeenCalled();
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
    (internals.bridge as typeof internals.bridge & { descriptor: { epoch: string } }).descriptor = { epoch: "test-epoch" };

    await host.prompt("$tdd fix it", [], "bridge");
    await host.steer("$tdd steer it", [], "bridge");
    await host.followUp("$tdd follow it", [], "bridge");
    // A legacy bridge fixture has no asynchronous snapshot publisher. Clearing
    // the optional snapshot exercises the raw command boundary without waiting
    // forever for a handoff that this unit test does not model.
    internals.bridgeSnapshot = undefined as never;
    await host.newSession("$tdd start it");
    expect(command.mock.calls).toEqual([
      [{ command: "prompt", text: "$tdd fix it" }],
      [{ command: "prompt", text: "$tdd steer it", deliverAs: "steer" }],
      [{ command: "prompt", text: "$tdd follow it", deliverAs: "followUp" }],
      [expect.objectContaining({ command: "new_session", initialPrompt: "$tdd start it" })],
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
      supportsImageInput: false,
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

  it("sanitizes a complete unknown runtime wrapper from full-chat export", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    fixture.session.sessionManager.entries = [
      { type: "message", id: "user", message: {
        role: "user",
        content: [{ type: "text", text: `<skill name="removed" location="/private/removed/SKILL.md">\nSECRET BODY\n</skill>\n\nKeep the request` }],
        timestamp: 1,
      } },
    ];
    await adopt(fixture);

    const markdown = await fixture.host.exportThreadMarkdown("session");
    expect(markdown).toContain("Keep the request");
    // A wrapper without validated Tau skill metadata is user-authored text;
    // exports must preserve it losslessly rather than silently deleting it.
    expect(markdown).toContain("<skill name=\"removed\" location=\"/private/removed/SKILL.md\">");
    expect(markdown).toContain("SECRET BODY");
    expect(markdown).toContain("location=\"/private/removed/SKILL.md\"");
  });
});
