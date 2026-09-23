import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot, PreparedPrompt, UiComposerCommand } from "../shared/contracts.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { HostExtension } from "./host-extensions.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import { prepareSkillPrompt } from "./skill-invocation.js";
import { promptImages } from "./prompt-attachments.js";
import { ThreadRuntime } from "./thread-runtime.js";

const commands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill", description: "Test-driven development" }];

/**
 * A kit that registers a runtime backend, standing in for whichever package
 * ships one. The host must reach an external runtime through this seam and
 * nothing else, so the tests below need no real backend kit.
 */
function backendKit(adapter: AgentRuntimeAdapter, composerCommands: readonly UiComposerCommand[] = [], order?: number): HostExtension {
  return {
    id: `test.${adapter.id}`,
    name: adapter.id,
    permissions: ["runtime:extend"],
    activate: (context) => context.services.registerRuntimeBackend({
      kind: adapter.id,
      ...(order !== undefined ? { order } : {}),
      adapter,
      listThreads: async () => [],
      lookup: async () => undefined,
      open: () => { throw new Error("this test never opens a thread through the provider"); },
      composerCommands: () => [...composerCommands],
    }),
  };
}

function localHost(adapter: AgentRuntimeAdapter) {
  const emitted: unknown[] = [];
  const prompt = vi.fn(async (_text: string, _options?: unknown) => undefined);
  const steer = vi.fn(async (_text: string, _images?: unknown) => undefined);
  const followUp = vi.fn(async (_text: string, _images?: unknown) => undefined);
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
  const isPi = adapter.id === "pi";
  const entries = () => session.sessionManager.getBranch();
  const backend: any = {
    kind: adapter.id,
    runtimeAdapter: adapter,
    threadId: "session",
    providerSessionId: "session",
    cwd: "/repo",
    // Pi streams its own events; an external runtime resolves its prompt when the turn ends.
    turnReporting: isPi ? "streamed" : "awaited",
    capabilities: isPi ? {
      journal: {
        entries,
        appendCustomEntry: (customType: string, data: unknown) => { session.sessionManager.appendCustomEntry(customType, data); },
        appendMessage: (message: unknown) => { session.sessionManager.entries.push({ type: "message", id: `message-${session.sessionManager.entries.length}`, message }); },
      },
      extensions: {
        bind: async () => undefined,
        unbind: () => undefined,
        setLifecycleHooks: () => undefined,
        shortcuts: () => [],
        runShortcut: async () => false,
      },
      reload: { reload: async () => undefined },
      completions: { complete: async () => "Test title", modelApi: () => undefined },
      shellAction: { isRunning: () => false, run: async () => ({ output: "", exitCode: 0, cancelled: false, truncated: false }) },
      compaction: { compact: async () => undefined },
      catalogWrite: { setModel: async () => undefined, setThinkingLevel: async () => undefined },
    } : {},
    start: async () => undefined,
    dispose: async () => undefined,
    waitForIdle: async () => undefined,
    state: () => ({
      streaming: session.isStreaming,
      idle: session.isIdle,
      hasMessages: session.messages.length > 0 || entries().some((entry: any) => entry.type === "message"),
      title: session.sessionName,
      sessionFile: session.sessionFile,
      activeTools: [],
      supportsImageInput: true,
      extensionCount: 0,
    }),
    catalogView: () => ({
      model: { provider: session.model.provider, id: session.model.id, name: session.model.id },
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
    }),
    models: async () => isPi ? [{ provider: session.model.provider, id: session.model.id, name: session.model.id }] : [],
    composerCommands: () => commands,
    persist: async () => undefined,
    setTitle: async (title: string) => { session.sessionName = title; },
  };
  const thread = new ThreadRuntime(backend, isPi ? { session } as never : undefined);
  backend.preparePrompt = async (text: string, selectedSkill?: any) => {
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
  };
  backend.transcript = async () => thread.adapterMessages.length > 0
    ? thread.adapterMessages
    : entries().flatMap((entry: any, index: number) => entry.type === "message" ? [visibleMessage(entry, index)] : []);
  backend.prompt = async (input: any) => {
    const runtimeText = input.prepared?.runtimeText ?? prepareSkillPrompt(input.text, adapter, commands).runtimeText;
    if (isPi) {
      // The Pi backend assembles Pi's own prompt options at its edge; the fake mirrors that.
      const images = promptImages(input.attachments ?? []);
      if (input.delivery === "prompt") {
        await session.prompt(runtimeText, {
          images,
          streamingBehavior: input.queued ? "followUp" : undefined,
          ...(input.onAdmitted ? { preflightResult: input.onAdmitted } : {}),
        });
      } else {
        const invoke = (input.delivery === "steer" ? session.steer : session.followUp) as (text: string, images?: unknown) => Promise<unknown>;
        await invoke(runtimeText, images);
      }
      return {};
    }
    await adapter.transport!.sendPrompt({
      cwd: "/repo",
      tauThreadId: "session",
      sessionId: "session",
      text: runtimeText,
      delivery: input.delivery,
      permissionLevel: "full",
    });
    return {};
  };
  backend.abort = async () => { if (adapter.id === "claude-code") await adapter.transport?.abort?.("session"); };
  // A non-Pi adapter reaches the host the way it does in production: as a registered backend.
  const host = new PiHost("/repo", (event) => emitted.push(event), {} as never, false, false, adapter.id === "pi"
    ? { runtimeAdapter: adapter }
    : { defaultBackendKind: adapter.id, hostExtensions: [backendKit(adapter)] });
  const internals = host as unknown as {
    threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
    projects: { label: () => undefined };
    index: { publishShellSoon: () => void };
    activateHostExtensions(): Promise<void>;
  };
  internals.projects.label = () => undefined;
  internals.index.publishShellSoon = () => undefined;
  const ready = adapter.id === "pi" ? Promise.resolve() : internals.activateHostExtensions();
  return { host, session, thread, internals, emitted, ready };
}

async function adopt(host: ReturnType<typeof localHost>): Promise<void> {
  await host.ready;
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
      attached: { session: { snapshot?: PiBridgeSnapshot } };
      projection: { attachedHostSnapshot(): HostSnapshot };
    };
    internals.attached.session.snapshot = {
      sessionId: "bridge",
      sessionFile: "/tmp/bridge.jsonl",
      cwd: "/repo",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "$tdd fix it" }],
        timestamp: 1,
      }],
      isStreaming: false,
      supportsImageInput: true,
      model: { provider: "anthropic", id: "model" },
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      composerCommands: commands,
    };

    expect(internals.projection.attachedHostSnapshot()).toMatchObject({
      supportsImageInput: true,
      messages: [{
        text: "fix it",
        skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd fix it" },
      }],
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
      clientMessages: { appendMarker(thread: unknown, clientMessageId: string, correlationText?: string): boolean };
      handleSessionEvent(event: unknown, thread: unknown, sessionId: string, cwd: string): void;
    };
    expect(hostInternals.clientMessages.appendMarker(fixture.thread, "request-in-flight", "keep tracking this")).toBe(true);

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
      permissionLevel: "full",
    }));
  });

  it("reprojects supplied skill catalogs through the selected Claude dialect", async () => {
    const adapter: AgentRuntimeAdapter = {
      id: "claude-code",
      capabilities: { skillInvocationDialect: "claude-code", ownsModelSelection: true, interactiveApprovals: false },
      transport: { sendPrompt: vi.fn(async () => ({})) },
    };
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, {
      defaultBackendKind: "claude-code",
      hostExtensions: [backendKit(adapter)],
      runtimeCommands: [{ ...commands[0], skillCommand: "/skill:tdd" }],
    });
    const internals = host as unknown as { activateHostExtensions(): Promise<void>; externalComposerCommands(kind: string, cwd: string): UiComposerCommand[] };
    await internals.activateHostExtensions();
    expect(internals.externalComposerCommands("claude-code", "/repo")).toEqual([{ ...commands[0], skillCommand: "/tdd" }]);
  });

  it("answers a draft's catalog from the backend, with the kind and the adapter's capabilities", async () => {
    const adapter: AgentRuntimeAdapter = { id: "codex@work", capabilities: { skillInvocationDialect: "codex", fileAttachments: true }, transport: { sendPrompt: vi.fn(async () => ({})) } };
    const kit: HostExtension = {
      id: "test.catalog",
      name: "catalog",
      permissions: ["runtime:extend"],
      activate: (context) => context.services.registerRuntimeBackend({
        kind: "codex@work",
        adapter,
        listThreads: async () => [],
        lookup: async () => undefined,
        open: () => { throw new Error("unused"); },
        composerCommands: () => [],
        newThreadCatalog: async () => ({ models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }], thinkingLevels: { "gpt-5.6-luna": ["default (low)", "low"] } }),
      }),
    };
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [kit] });
    await (host as unknown as { activateHostExtensions(): Promise<void> }).activateHostExtensions();
    await expect(host.runtimeCatalog("codex@work")).resolves.toEqual({
      kind: "codex@work",
      models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
      thinkingLevels: { "gpt-5.6-luna": ["default (low)", "low"] },
      runtimeCapabilities: { skillInvocationDialect: "codex", fileAttachments: true },
    });
  });

  it("lists runtimes Pi first, then by their order whatever order the kits activated in", async () => {
    const kit = (id: string, order?: number) => backendKit({ id, capabilities: { skillInvocationDialect: "claude-code" }, transport: { sendPrompt: vi.fn(async () => ({})) } }, [], order);
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, {
      hostExtensions: [kit("zeta"), kit("antigravity", 30), kit("codex", 20), kit("agent-sdk", 10), kit("alpha")],
    });
    const internals = host as unknown as { activateHostExtensions(): Promise<void>; runtimeBackends(): Array<{ kind: string }> };
    await internals.activateHostExtensions();
    expect(internals.runtimeBackends().map((backend) => backend.kind)).toEqual(["pi", "agent-sdk", "codex", "antigravity", "zeta", "alpha"]);
  });

  it("prepares a new thread's prompt for the backend the client names", async () => {
    const adapter: AgentRuntimeAdapter = {
      id: "claude-code",
      capabilities: { skillInvocationDialect: "claude-code" },
      transport: { sendPrompt: vi.fn(async () => ({})) },
    };
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [backendKit(adapter)] });
    const internals = host as unknown as { activateHostExtensions(): Promise<void>; runtimeBackends(): unknown };
    await internals.activateHostExtensions();

    expect(internals.runtimeBackends()).toEqual([{ kind: "pi", label: "Pi" }, { kind: "claude-code", label: "claude-code" }]);
    // Without `newThreadCatalog` a backend offers a draft nothing; Pi's catalog is the snapshot's.
    await expect(host.runtimeCatalog("claude-code")).resolves.toBeUndefined();
    await expect(host.runtimeCatalog("pi")).resolves.toBeUndefined();
    await expect(host.preparePrompt("hello", undefined, undefined, "claude-code")).resolves.toMatchObject({ backendKind: "claude-code" });
    await expect(host.preparePrompt("hello")).resolves.toMatchObject({ backendKind: "pi" });
    await expect(host.preparePrompt("hello", undefined, undefined, "acme")).rejects.toThrow(/not installed/u);
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
      attached: { session: { client?: { command: typeof command; descriptor?: { epoch: string } }; snapshot?: PiBridgeSnapshot | { sessionId: string } } };
    };
    internals.attached.session.client = { command };
    internals.attached.session.snapshot = { sessionId: "bridge" };
    internals.attached.session.client!.descriptor = { epoch: "test-epoch" };

    await host.prompt("$tdd fix it", [], "bridge");
    await host.steer("$tdd steer it", [], "bridge");
    await host.followUp("$tdd follow it", [], "bridge");
    // A legacy bridge fixture has no asynchronous snapshot publisher. Clearing
    // the optional snapshot exercises the raw command boundary without waiting
    // forever for a handoff that this unit test does not model.
    internals.attached.session.snapshot = undefined;
    await host.newSession("$tdd start it");
    expect(command.mock.calls).toEqual([
      [{ command: "prompt", text: "$tdd fix it" }],
      [{ command: "prompt", text: "$tdd steer it", deliverAs: "steer" }],
      [{ command: "prompt", text: "$tdd follow it", deliverAs: "followUp" }],
      [expect.objectContaining({ command: "new_session", initialPrompt: "$tdd start it" })],
    ]);
  });

  it("accepts a prepared prompt from the attached Pi when creating its next thread", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false, {
      runtimeAdapter: { id: "pi", capabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities },
    });
    const currentSnapshot = {
      sessionId: "current-thread",
      sessionFile: "/tmp/current-thread.jsonl",
      cwd: "/repo",
      messages: [],
      isStreaming: false,
      supportsImageInput: false,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      composerCommands: [],
    } as PiBridgeSnapshot;
    const command = vi.fn(async (input: { command: string; text?: string; requestId?: string }) => {
      if (input.command === "prepare_prompt") return {
        visibleText: input.text,
        runtimeText: input.text,
        runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
        sourceFingerprint: clientMessageFingerprint(input.text ?? "", []),
      };
      if (input.command === "new_session") return {
        requestId: input.requestId,
        snapshot: {
          ...currentSnapshot,
          sessionId: "next-thread",
          sessionFile: "/tmp/next-thread.jsonl",
          newSessionRequestId: input.requestId,
        },
      };
      return { accepted: true };
    });
    const internals = host as unknown as {
      attached: { session: { client?: { command: typeof command; descriptor: { epoch: string } }; snapshot?: PiBridgeSnapshot } };
    };
    internals.attached.session.client = { command, descriptor: { epoch: "test-epoch" } };
    internals.attached.session.snapshot = currentSnapshot;

    const prepared = await host.preparePrompt("start it");

    await expect(host.newSession("start it", [], "/repo", undefined, prepared)).resolves.toMatchObject({
      submission: { accepted: true },
      sessionId: "next-thread",
    });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      command: "new_session",
      prepared: expect.objectContaining({ runtimeText: "start it" }),
    }));
  });

  it("re-prepares a new-thread prompt when attached Pi replaced its preflight owner", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false, {
      runtimeAdapter: { id: "pi", capabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities },
    });
    const currentSnapshot = {
      sessionId: "pi-thread",
      sessionFile: "/tmp/pi-thread.jsonl",
      cwd: "/repo",
      messages: [],
      isStreaming: false,
      supportsImageInput: false,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      composerCommands: [],
    } as PiBridgeSnapshot;
    const command = vi.fn(async (input: { command: string; text?: string; requestId?: string }) => {
      if (input.command === "prepare_prompt") return {
        visibleText: input.text,
        runtimeText: input.text,
        runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
        sourceFingerprint: clientMessageFingerprint(input.text ?? "", []),
      };
      if (input.command === "new_session") return {
        requestId: input.requestId,
        snapshot: {
          ...currentSnapshot,
          sessionId: "next-pi-thread",
          sessionFile: "/tmp/next-pi-thread.jsonl",
          newSessionRequestId: input.requestId,
        },
      };
      return { accepted: true };
    });
    const internals = host as unknown as {
      attached: { session: { client?: { command: typeof command; descriptor: { epoch: string } }; snapshot?: PiBridgeSnapshot } };
    };
    internals.attached.session.client = { command, descriptor: { epoch: "test-epoch" } };
    internals.attached.session.snapshot = currentSnapshot;
    const preparedByPreviousRuntime: PreparedPrompt = {
      tauThreadId: "previous-local-pi-thread",
      providerSessionId: "previous-local-pi-thread",
      sessionId: "previous-local-pi-thread",
      backendKind: "pi",
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      visibleText: "start it",
      runtimeText: "start it",
      sourceFingerprint: clientMessageFingerprint("start it", []),
    };

    await expect(host.newSession("start it", [], "/repo", undefined, preparedByPreviousRuntime)).resolves.toMatchObject({
      submission: { accepted: true },
      sessionId: "next-pi-thread",
    });
    expect(command).toHaveBeenNthCalledWith(1, { command: "prepare_prompt", text: "start it" });
    expect(command).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: "new_session",
      prepared: expect.objectContaining({ runtimeText: "start it" }),
    }));
  });

  it("validates and forwards image attachments to the Pi bridge", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false, {
      runtimeAdapter: { id: "pi", capabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities },
    });
    const command = vi.fn(async () => undefined);
    const internals = host as unknown as {
      attached: { session: { client?: { command: typeof command; descriptor?: { epoch: string } }; snapshot?: PiBridgeSnapshot | { sessionId: string } } };
    };
    internals.attached.session.client = { command };
    internals.attached.session.snapshot = {
      sessionId: "bridge",
      sessionFile: "/tmp/bridge.jsonl",
      cwd: "/repo",
      messages: [],
      isStreaming: false,
      supportsImageInput: true,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
    };
    const attachment = { kind: "image" as const, name: "pixel.png", mimeType: "image/png", data: "AQ==", size: 1 };

    await host.prompt("describe this", [attachment], "bridge");

    expect(command).toHaveBeenCalledWith({ command: "prompt", text: "describe this", attachments: [attachment] });
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
      attached: { session: { client?: { command: typeof command; descriptor?: { epoch: string } }; snapshot?: PiBridgeSnapshot | { sessionId: string } } };
    };
    internals.attached.session.client = { command };
    internals.attached.session.snapshot = {
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

describe("errored Pi turns", () => {
  it("surfaces the provider's error as a notice when the assistant message carries no text", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    await adopt(fixture);
    const hostInternals = fixture.host as unknown as {
      handleSessionEvent(event: unknown, thread: unknown, sessionId: string, cwd: string): void;
    };
    const assistant = { role: "assistant", content: [], timestamp: 9, stopReason: "error", errorMessage: "400 You're out of extra usage." };
    hostInternals.handleSessionEvent({ type: "message_start", message: assistant }, fixture.thread, "session", "/repo");
    hostInternals.handleSessionEvent({ type: "message_end", message: assistant }, fixture.thread, "session", "/repo");
    expect(fixture.emitted).toContainEqual({ type: "notice", sessionId: "session", level: "error", message: "400 You're out of extra usage." });
  });

  it("marks the thread's last turn failed until an answer settles a run", async () => {
    const fixture = localHost(PI_AGENT_RUNTIME_ADAPTER);
    await adopt(fixture);
    const hostInternals = fixture.host as unknown as {
      handleSessionEvent(event: unknown, thread: unknown, sessionId: string, cwd: string): void;
      index: { setTurnError(sessionId: string, message: string | undefined): void };
    };
    const setTurnError = vi.spyOn(hostInternals.index, "setTurnError");
    const send = (event: unknown) => hostInternals.handleSessionEvent(event, fixture.thread, "session", "/repo");
    const failed = { role: "assistant", content: [], timestamp: 9, stopReason: "error", errorMessage: "overloaded" };
    const answered = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 10, stopReason: "stop" };

    send({ type: "agent_start" });
    send({ type: "message_start", message: failed });
    send({ type: "message_end", message: failed });
    send({ type: "agent_settled" });
    expect(setTurnError).toHaveBeenLastCalledWith("session", "overloaded");

    // A retry that answers in the same run leaves no error behind.
    send({ type: "agent_start" });
    send({ type: "message_end", message: failed });
    send({ type: "message_start", message: answered });
    send({ type: "message_end", message: answered });
    send({ type: "agent_settled" });
    expect(setTurnError).toHaveBeenLastCalledWith("session", undefined);
  });
});
