import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostMcpToolGate, HostMcpToolProvider, HostTurnObserver, RuntimeExtensionContribution } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createTakeoverHostExtension } from "./host.js";
import { TAKEOVER_EXTENSION_ID, type Takeover } from "./protocol.js";

afterEach(() => { vi.useRealTimers(); });

type ToolAnswer = { content: Array<{ text: string }>; isError?: boolean; terminate?: boolean };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolAnswer> };
type ToolCallHandler = (event: { toolName: string }) => { block: true; reason: string } | undefined;

/** Evidence Kit as far as this kit calls it: a pause and a resume granted to it. */
function fakeEvidence(calls: Array<[string, unknown]>): HostExtension {
  return {
    id: "tau.evidence",
    name: "Evidence",
    activate: (context) => {
      context.registerCommand("pause", (input) => { calls.push(["pause", input]); }, { callers: [TAKEOVER_EXTENSION_ID] });
      context.registerCommand("resume", (input) => { calls.push(["resume", input]); }, { callers: [TAKEOVER_EXTENSION_ID] });
    },
  };
}

async function activate(options: { timeoutMs?: number } = {}) {
  const observers: HostTurnObserver[] = [];
  const runtime: RuntimeExtensionContribution[] = [];
  const mcp: HostMcpToolProvider[] = [];
  const gates: HostMcpToolGate[] = [];
  const events: PublishedKitEvent[] = [];
  const evidence: Array<[string, unknown]> = [];
  const kit = await activateHostKit(createTakeoverHostExtension(options), {
    thread: ((sessionId?: string) => ({ sessionId: sessionId ?? "thread", cwd: "/project", sessionFile: `/sessions/${sessionId ?? "thread"}.jsonl`, sessionName: () => "Fix the login" })) as never,
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerRuntimeExtension: (name, factory) => { runtime.push({ name, factory }); return () => undefined; },
    mcp: { registerTools: (tools) => { mcp.push(tools); return () => undefined; }, gate: (gate) => { gates.push(gate); return () => undefined; }, connect: async () => undefined },
  }, (event) => events.push(event));
  await kit.activate(fakeEvidence(evidence));
  const pushes: unknown[] = [];
  await kit.activate({
    id: "tau.push",
    name: "Push",
    activate: (context) => { context.registerCommand("notify", (input) => { pushes.push(input); }, { callers: [TAKEOVER_EXTENSION_ID] }); },
  });
  const invoke = (command: string, input?: unknown) => kit.invoke(TAKEOVER_EXTENSION_ID, command, input);

  /** The kit's Pi half for one thread: its tool and its `tool_call` handler. */
  const pi = async (sessionId: string) => {
    const tools: Tool[] = [];
    const handlers: ToolCallHandler[] = [];
    await runtime[0]!.factory({
      registerTool: (tool: never) => tools.push(tool),
      on: (event: string, handler: ToolCallHandler) => { if (event === "tool_call") handlers.push(handler); },
    } as never, { sessionId, cwd: "/project" });
    return { tool: tools[0]!, onToolCall: handlers[0]! };
  };
  /** Waits until the host published a list that passes. */
  const published = (check: (list: Takeover[]) => boolean) => vi.waitFor(() => {
    const last = events.filter((event) => event.name === "state").at(-1)?.payload as { takeovers: Takeover[] } | undefined;
    if (!last || !check(last.takeovers)) throw new Error("The kit never published that.");
    return last.takeovers;
  }, { interval: 5 });
  return { observers, mcp, gates, events, evidence, pushes, invoke, pi, published };
}

describe("Takeover host extension", () => {
  it("hands a settings target from the tool to the card and waits for consent", async () => {
    const { pi, invoke, published } = await activate();
    const { tool } = await pi("thread");
    const answer = tool.execute("call", { reason: "Allow simulator control", target: "settings", settingsPage: "devices.settings" }, undefined, undefined, undefined);
    const [takeover] = await published((list) => list.length === 1);
    expect(takeover!.target).toEqual({ kind: "settings", page: "devices.settings" });
    await invoke("done", { id: takeover!.id });
    expect((await answer).isError).toBeUndefined();
    const invalid = await tool.execute("call2", { reason: "Allow simulator control", target: "settings" }, undefined, undefined, undefined);
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).toContain("settingsPage");
  });

  it("waits for the user, pauses evidence first, and answers the agent when the user is done", async () => {
    const { pi, invoke, published, evidence } = await activate();
    const { tool } = await pi("thread");
    expect(tool.name).toBe("request_takeover");
    const answer = tool.execute("call", { reason: "Sign in to staging", target: "preview", url: "http://127.0.0.1:8741/login" }, undefined, undefined, { sessionManager: { getSessionId: () => "thread" } });

    const [takeover] = await published((list) => list.length === 1);
    expect(takeover).toMatchObject({
      threadId: "thread", reason: "Sign in to staging", target: { kind: "preview", url: "http://127.0.0.1:8741/login" },
      title: "Fix the login", sessionFile: "/sessions/thread.jsonl",
    });
    expect(evidence).toEqual([["pause", { threadId: "thread", reason: "The user took over: Sign in to staging" }]]);
    expect(await invoke("state")).toEqual([takeover]);

    expect(await invoke("done", { id: takeover!.id })).toBe(true);
    const result = await answer;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^The user is done/u);
    await published((list) => list.length === 0);
    expect(evidence.at(-1)).toEqual(["resume", { threadId: "thread" }]);
    expect(await invoke("done", { id: takeover!.id })).toBe(false);
  });

  it("asks Push to tell the phone it is the user's turn, with the agent's reason", async () => {
    const { pi, invoke, published, pushes } = await activate();
    const { tool } = await pi("thread");
    const answer = tool.execute("call", { reason: "Enter the code from your phone" }, undefined, undefined, undefined);
    const [takeover] = await published((list) => list.length === 1);
    expect(pushes).toEqual([{ threadId: "thread", kind: "turn", text: "Enter the code from your phone" }]);
    await invoke("done", { id: takeover!.id });
    await answer;
  });

  it("stops the agent's turn when the user cancels", async () => {
    const { pi, invoke, published } = await activate();
    const { tool } = await pi("thread");
    const answer = tool.execute("call", { reason: "Solve the captcha" }, undefined, undefined, undefined);
    const [takeover] = await published((list) => list.length === 1);
    expect(takeover!.target).toEqual({ kind: "none" });
    await invoke("cancel", { id: takeover!.id });
    const result = await answer;
    expect(result).toMatchObject({ isError: true, terminate: true });
    expect(result.content[0]!.text).toMatch(/cancelled/u);
  });

  it("holds Computer Use and the Preview for every thread and runtime while the user is in control", async () => {
    const { pi, gates, invoke, published } = await activate();
    const first = await pi("thread");
    const other = await pi("other");
    expect(other.onToolCall({ toolName: "computer_use_click" })).toBeUndefined();

    const answer = first.tool.execute("call", { reason: "Enter the 2FA code", target: "window" }, undefined, undefined, undefined);
    const [takeover] = await published((list) => list.length === 1);
    for (const name of ["computer_use_click", "computer_use_get_window_state", "preview_type", "preview_snapshot"]) {
      expect(other.onToolCall({ toolName: name })).toMatchObject({ block: true, reason: expect.stringContaining("Enter the 2FA code") });
    }
    expect(other.onToolCall({ toolName: "bash" })).toBeUndefined();
    expect(await gates[0]!({ threadId: "codex", cwd: "/project", toolName: "preview_click", input: {}, signal: new AbortController().signal, confirm: async () => true })).toMatchObject({ block: true });
    expect(await gates[0]!({ threadId: "codex", cwd: "/project", toolName: "attach_evidence", input: {}, signal: new AbortController().signal, confirm: async () => true })).toBeUndefined();

    await invoke("done", { id: takeover!.id });
    await answer;
    expect(other.onToolCall({ toolName: "computer_use_click" })).toBeUndefined();
  });

  it("goes where the agent last worked when it names no target", async () => {
    const { pi, observers, invoke, published } = await activate();
    const { tool } = await pi("thread");
    observers[0]!.toolEnded?.("thread", { id: "c1", name: "computer_use_click", args: {}, status: "done", startedAt: 1 }, "/project");
    const answer = tool.execute("call", { reason: "Sign in to the app" }, undefined, undefined, undefined);
    const [takeover] = await published((list) => list.length === 1);
    expect(takeover!.target).toEqual({ kind: "window" });
    await invoke("done", { id: takeover!.id });
    await answer;

    observers[0]!.toolEnded?.("thread", { id: "c2", name: "mcp__tau__preview_click", args: {}, status: "done", startedAt: 2 }, "/project");
    const again = tool.execute("call", { reason: "Sign in" }, undefined, undefined, undefined);
    const [next] = await published((list) => list.length === 1 && list[0]!.id !== takeover!.id);
    expect(next!.target).toEqual({ kind: "preview" });
    await invoke("done", { id: next!.id });
    await again;
  });

  it("sends a page the agent never showed to the user's own browser, and refuses what is not a web page", async () => {
    const { pi, invoke, published } = await activate();
    const { tool } = await pi("thread");
    const answer = tool.execute("call", { reason: "Approve the device", url: "https://example.test/device" }, undefined, undefined, undefined);
    const [takeover] = await published((list) => list.length === 1);
    expect(takeover!.target).toEqual({ kind: "browser", url: "https://example.test/device" });
    await invoke("done", { id: takeover!.id });
    await answer;

    const refused = await tool.execute("call", { reason: "Sign in", url: "file:///etc/passwd" }, undefined, undefined, undefined);
    expect(refused).toMatchObject({ isError: true });
    expect((await tool.execute("call", { reason: "Sign in", target: "browser" }, undefined, undefined, undefined)).content[0]!.text).toMatch(/needs the page's url/u);
  });

  it("offers the tool over MCP bound to the credential's thread, one request per thread", async () => {
    const { mcp, invoke, published } = await activate();
    const [tool] = mcp[0]!({ sessionId: "codex-thread", cwd: "/project" }) as unknown as Tool[];
    const answer = tool!.execute("call", { reason: "Sign in" }, undefined, undefined, undefined);
    const [takeover] = await published((list) => list.length === 1);
    expect(takeover!.threadId).toBe("codex-thread");
    expect((await tool!.execute("call", { reason: "Again" }, undefined, undefined, undefined)).content[0]!.text).toMatch(/already waits/u);
    await invoke("done", { id: takeover!.id });
    expect((await answer).isError).toBeUndefined();
  });

  it("lets go when the run is stopped, the runtime closes, or nobody comes", async () => {
    vi.useFakeTimers();
    const { pi, observers, published, evidence } = await activate({ timeoutMs: 60_000 });
    const { tool } = await pi("thread");

    const stop = new AbortController();
    const aborted = tool.execute("call", { reason: "Sign in" }, stop.signal, undefined, undefined);
    await vi.waitFor(() => expect(evidence).toHaveLength(1));
    stop.abort();
    expect((await aborted).content[0]!.text).toBe("The takeover was stopped.");
    expect(evidence.at(-1)).toEqual(["resume", { threadId: "thread" }]);

    const closed = tool.execute("call", { reason: "Sign in" }, undefined, undefined, undefined);
    await vi.waitFor(() => expect(evidence).toHaveLength(3));
    await observers[0]!.closed?.("thread");
    expect((await closed).isError).toBe(true);

    const late = tool.execute("call", { reason: "Sign in" }, undefined, undefined, undefined);
    await vi.waitFor(() => expect(evidence).toHaveLength(5));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await late).content[0]!.text).toMatch(/within 30 minutes/u);
    vi.useRealTimers();
    await published((list) => list.length === 0);
  });
});
