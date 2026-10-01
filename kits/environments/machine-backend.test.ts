import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostBackendOpenContext, HostMachine, HostMachineServices, HostPushEvent, HostTranscriptCursor, TranscriptPage, UiMessage, UiSession, UiThreadUsage, UiToolRun } from "tau/host-extension";
import { threadUsageFrom } from "../../src/main/test-support/machine-backend-harness.js";
import { createMachineBackendProvider, machineThreadId, machineUsageTallies, parseMachineThreadId, toRuntimeEvents } from "./machine-backend.js";

afterEach(() => vi.useRealTimers());

const rex = { id: "0123456789abcdef0123456789abcdef", name: "rex", status: "connected", address: "wss://rex/" } satisfies HostMachine;
const session = { id: "t1", path: "/remote/t1", title: "Remote work", modifiedAt: 4, projectPath: "/nonexistent/x", projectName: "x", messageCount: 2, backendKind: "codex", modelProvider: "openai", model: "gpt-test" } satisfies UiSession;
const message = (id: string, text = id): UiMessage => ({ id, role: "assistant", text, timestamp: 1 });
const tool: UiToolRun = { id: "tool", name: "bash", args: { command: "pwd" }, status: "running", startedAt: 1 };
const page = (messages: UiMessage[] = [message("old")], olderCursor?: HostTranscriptCursor): TranscriptPage => ({ sessionId: session.id, messages, hasMore: olderCursor !== undefined, ...(olderCursor ? { olderCursor } : {}) });

function fixture() {
  let machines: HostMachine[] = [rex];
  let sessions: UiSession[] = [session];
  let listener: ((push: HostPushEvent) => void) | undefined;
  const stop = vi.fn(() => { listener = undefined; });
  const services: HostMachineServices = {
    self: { id: "here", name: "here", version: "1" }, list: () => machines,
    subscribe: vi.fn(() => () => undefined), call: vi.fn(), watch: vi.fn(() => () => undefined), upload: vi.fn(),
    request: vi.fn(async (_machine, method) => method === "transcript-page" ? page() : undefined),
    index: vi.fn(() => ({ projects: [], sessions })), subscribeIndex: vi.fn(() => () => undefined),
    running: () => new Set(), followThread: vi.fn((_machine, _session, next) => { listener = next; return stop; }),
  };
  const context: HostBackendOpenContext = {
    projectName: "x", permissionLevel: () => "full", onMessage: vi.fn(), onEvent: vi.fn(), ask: vi.fn(async () => ({ confirmed: true })),
  };
  const provider = createMachineBackendProvider(services);
  const open = () => provider.open(machineThreadId(rex.id, session.id), session.projectPath, { resume: true }, context);
  return { services, context, provider, open, stop, push: (event: HostPushEvent) => listener?.(event), setMachines: (value: HostMachine[]) => { machines = value; }, setSessions: (value: UiSession[]) => { sessions = value; } };
}

describe("machine backend identities and index", () => {
  it("splits only the first separator and retains the complete remote id", () => {
    const id = machineThreadId(rex.id, "remote~nested~id");
    expect(parseMachineThreadId(id)).toEqual({ machine: rex.id, sessionId: "remote~nested~id" });
    for (const invalid of ["", "t1", "~t1", "rex~"]) expect(parseMachineThreadId(invalid)).toBeUndefined();
  });

  it("lists top-level nonempty sessions with their counts, model and machine, including cached offline rows", async () => {
    const f = fixture();
    f.setSessions([session, { ...session, id: "child", parentThreadId: "t1" }, { ...session, id: "empty", messageCount: 0 }]);
    expect(f.provider).toMatchObject({ kind: "machine", label: "Another machine", order: 90, hidden: true });
    const record = { threadId: machineThreadId(rex.id, session.id), cwd: session.projectPath, title: session.title, updatedAt: 4, messages: [], messageCount: 2, model: { provider: "openai", id: "gpt-test" }, machine: { id: rex.id, name: "rex", backendKind: "codex", modelProvider: "openai" } };
    expect(await f.provider.listThreads()).toEqual([record]);
    expect(await f.provider.lookup(record.threadId)).toEqual(record);
    expect(await f.provider.lookup("missing~thread")).toBeUndefined();
    f.setMachines([{ ...rex, status: "offline" }]);
    expect(await f.provider.listThreads()).toEqual([record]);
    f.setMachines([]);
    expect(await f.provider.listThreads()).toEqual([]);
  });

  it("refuses creating a machine thread through the runtime picker", async () => {
    const f = fixture();
    await expect(f.provider.open("rex~new", "/remote", { resume: false }, f.context)).rejects.toThrow("Start threads on another machine with Run on.");
    expect(f.services.request).not.toHaveBeenCalled();
  });

  it("keeps mutually paired indexes stable and preserves local ids containing separators", async () => {
    const a = fixture();
    const b = fixture();
    const here = { ...rex, id: "a".repeat(32), name: "mac" };
    b.setMachines([here]);
    const localA = { ...session, id: "saved~thread" };
    a.setSessions([session]);
    b.setSessions([localA]);
    for (let round = 0; round < 4; round += 1) {
      const [recordsA, recordsB] = await Promise.all([a.provider.listThreads(), b.provider.listThreads()]);
      expect(recordsA.map((record) => record.threadId)).toEqual([machineThreadId(rex.id, session.id)]);
      expect(recordsB.map((record) => record.threadId)).toEqual([machineThreadId(here.id, localA.id)]);
      const proxy = (record: typeof recordsA[number]): UiSession => ({ ...session, id: record.threadId, backendKind: "machine", machine: record.machine });
      a.setSessions([session, ...recordsB.map(proxy)]);
      b.setSessions([localA, ...recordsA.map(proxy)]);
    }
    expect(await a.provider.lookup(machineThreadId(rex.id, machineThreadId(here.id, localA.id)))).toBeUndefined();
    expect(await b.provider.lookup(machineThreadId(here.id, localA.id))).toMatchObject({ threadId: machineThreadId(here.id, localA.id) });
  });

  it.each([false, true])("preserves remote usage including subscription = %s under hostile local prices", async (subscription) => {
    const usage: UiThreadUsage = {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 37, costUsd: 0.5, turns: 5,
      ...(subscription ? { subscription: { inputTokens: 5, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 2, totalTokens: 18, turns: 2, apiValueUsd: 0.25 } } : {}),
    };
    const prices = { overrides: vi.fn(() => ({ "openai/gpt-test": { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } })), apiPrice: vi.fn(() => ({ input: 999, output: 999, cacheRead: 999, cacheWrite: 999 })), subscription: vi.fn(() => true) };
    const tallies = machineUsageTallies(usage);
    expect(threadUsageFrom(tallies, prices)).toEqual(usage);
    expect(prices.apiPrice).not.toHaveBeenCalled();
    expect(prices.subscription).not.toHaveBeenCalled();
    const f = fixture();
    f.setSessions([{ ...session, usage }]);
    expect((await f.provider.listThreads())[0]?.usage).toEqual(tallies);
  });

  it("preserves zero-valued subscription prices", () => {
    const usage: UiThreadUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0, subscription: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, turns: 0, apiValueUsd: 0 } };
    expect(threadUsageFrom(machineUsageTallies(usage), { overrides: () => ({}), apiPrice: () => ({ input: 999, output: 999, cacheRead: 999, cacheWrite: 999 }), subscription: () => true })).toEqual(usage);
  });
});

describe("machine runtime event translation", () => {
  const cases: Array<[HostPushEvent, unknown]> = [
    [{ type: "assistant-start", sessionId: "t1", id: "a", timestamp: 2 }, { type: "assistant-start", id: "a", timestamp: 2 }],
    [{ type: "assistant-delta", sessionId: "t1", id: "a", delta: "hello" }, { type: "assistant-delta", id: "a", delta: "hello" }],
    [{ type: "assistant-thinking", sessionId: "t1", id: "a", delta: "think" }, { type: "assistant-thinking", id: "a", delta: "think" }],
    [{ type: "assistant-end", sessionId: "t1", message: message("a") }, { type: "assistant-end", message: message("a") }],
    [{ type: "user-message", sessionId: "t1", message: { ...message("u"), role: "user" } }, { type: "user-message", message: { ...message("u"), role: "user" } }],
    [{ type: "tool-start", sessionId: "t1", tool }, { type: "tool-start", tool }],
    [{ type: "tool-update", sessionId: "t1", id: "tool", output: "output" }, { type: "tool-update", id: "tool", output: "output" }],
    [{ type: "tool-end", sessionId: "t1", tool: { ...tool, status: "done" } }, { type: "tool-end", tool: { ...tool, status: "done" } }],
    [{ type: "tool-end-delta", sessionId: "t1", tool: { ...tool, status: "done" }, after: 2, keep: 0, drop: 0, text: "", length: 100 }, { type: "tool-end", tool: { ...tool, status: "done", outputDeferred: true, outputLength: 100 } }],
    [{ type: "queue", sessionId: "t1", steering: ["s"], followUp: ["q"] }, { type: "queue", steering: ["s"], followUp: ["q"] }],
    [{ type: "notice", sessionId: "t1", message: "note", level: "warning" }, { type: "notice", message: "note", level: "warning" }],
    [{ type: "agent-status", sessionId: "t1", running: true }, { type: "turn-started" }],
    [{ type: "agent-status", sessionId: "t1", running: false }, { type: "turn-settled", status: "completed" }],
    [{ type: "host-update", update: { version: 1, type: "run", event: "started", sessionId: "t1" } }, { type: "turn-started" }],
    [{ type: "host-update", update: { version: 1, type: "run", event: "settled", sessionId: "t1" } }, { type: "turn-settled", status: "completed" }],
    [{ type: "host-update", update: { version: 1, type: "run", event: "aborted", sessionId: "t1" } }, { type: "turn-settled", status: "interrupted" }],
  ];
  it.each(cases)("maps $type without its remote session id", (push, expected) => expect(toRuntimeEvents(push)).toEqual([expected]));
  it("ignores unrelated pushes", () => expect(toRuntimeEvents({ type: "event-log", sessionId: "t1", timestamp: 1, label: "ignored" })).toEqual([]));
});

const image = { kind: "image", data: "AA==", size: 1, mimeType: "image/png", name: "x.png" } as const;

describe("a machine thread's home takes its renames, images and model changes", () => {
  it("sends images as content to the home machine's kit and never as a path", async () => {
    const f = fixture();
    const backend = await f.open();
    await backend.prompt({ text: "look", delivery: "steer", attachments: [image] });
    expect(f.services.call).toHaveBeenCalledWith(rex.id, "tau.environments", "thread-send", { sessionId: "t1", text: "look", delivery: "steer", attachments: [image] }, { timeoutMs: 120_000 });
    expect(f.services.request).not.toHaveBeenCalledWith(rex.id, "send-to-thread", expect.anything());
  });

  it.each([
    ["unknown-command", undefined],
    ["unknown-extension", undefined],
    ["failed", 'Host extension Machines has no command "thread-send".'],
  ])("asks to update a machine without the command (%s)", async (code, text) => {
    const f = fixture();
    const backend = await f.open();
    const error = Object.assign(new Error(text ?? "missing"), { code });
    f.services.call = vi.fn(async () => { throw error; });
    await expect(backend.prompt({ text: "x", delivery: "prompt", attachments: [image] })).rejects.toMatchObject({
      message: "rex runs an older Tau that cannot take images from here yet. Update rex in Settings → Machines.", code, cause: error,
    });
  });

  it("keeps other failures of the home machine unchanged", async () => {
    const f = fixture();
    const backend = await f.open();
    const error = Object.assign(new Error("Read only"), { code: "forbidden" });
    f.services.call = vi.fn(async () => { throw error; });
    await expect(backend.prompt({ text: "x", delivery: "prompt", attachments: [image] })).rejects.toBe(error);
    await expect(backend.setTitle("Name", "renamed")).rejects.toBe(error);
  });

  it("renames on the home machine and shows the title at once; other sources stay local", async () => {
    const f = fixture();
    const backend = await f.open();
    await backend.setTitle("Generated", "generated");
    await backend.setTitle("Derived", "derived");
    expect(f.services.call).not.toHaveBeenCalled();
    await backend.setTitle("Better name", "renamed");
    expect(f.services.call).toHaveBeenCalledExactlyOnceWith(rex.id, "tau.environments", "thread-rename", { sessionId: "t1", title: "Better name" }, undefined);
    expect(backend.state().title).toBe("Better name");
  });

  it("does not rename while the machine is unreachable", async () => {
    const f = fixture();
    const backend = await f.open();
    f.setMachines([{ ...rex, status: "offline" }]);
    await expect(backend.setTitle("Name", "renamed")).rejects.toThrow("rex is not reachable right now.");
    expect(backend.state().title).toBe("Remote work");
  });

  it("lists the home machine's models for the thread's runtime and keeps them for a while", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gpt = { provider: "openai", id: "gpt-test", name: "GPT Test", images: true };
    const small = { provider: "openai", id: "gpt-small", name: "GPT Small" };
    f.services.request = vi.fn(async (_machine, method) => method === "runtime-catalog" ? { kind: "codex", models: [gpt, small], thinkingLevels: {} } : page());
    const backend = await f.open();
    expect(backend.state().supportsImageInput).toBe(false);
    expect(await backend.models()).toEqual([gpt, small]);
    expect(f.services.request).toHaveBeenCalledWith(rex.id, "runtime-catalog", ["codex"], { timeoutMs: 5000 });
    expect(backend.state().supportsImageInput).toBe(true);
    await backend.models();
    expect(vi.mocked(f.services.request).mock.calls.filter(([, method]) => method === "runtime-catalog")).toHaveLength(1);
    vi.setSystemTime(Date.now() + 31_000);
    await backend.models();
    expect(vi.mocked(f.services.request).mock.calls.filter(([, method]) => method === "runtime-catalog")).toHaveLength(2);
  });

  it("serves the last model list when the machine does not answer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gpt = { provider: "openai", id: "gpt-test", name: "GPT Test" };
    const backend = await f.open();
    f.services.request = vi.fn(async () => ({ kind: "codex", models: [gpt], thinkingLevels: {} }));
    expect(await backend.models()).toEqual([gpt]);
    f.services.request = vi.fn(async () => { throw new Error("offline"); });
    vi.setSystemTime(Date.now() + 31_000);
    expect(await backend.models()).toEqual([gpt]);
  });

  it("changes the model on the home machine, not in a local session", async () => {
    const f = fixture();
    f.services.request = vi.fn(async (_machine, method) => method === "runtime-catalog" ? { kind: "codex", models: [{ provider: "openai", id: "gpt-small", name: "GPT Small", images: true }], thinkingLevels: {} } : page());
    const backend = await f.open();
    await backend.models();
    await backend.capabilities.catalogWrite!.setModel("openai", "gpt-small");
    expect(f.services.call).toHaveBeenCalledExactlyOnceWith(rex.id, "tau.environments", "thread-model", { sessionId: "t1", provider: "openai", id: "gpt-small" }, undefined);
    expect(backend.catalogView().model).toEqual({ provider: "openai", id: "gpt-small", name: "GPT Small" });
    expect(backend.state().supportsImageInput).toBe(true);
    await expect(backend.capabilities.catalogWrite!.setThinkingLevel("high")).rejects.toThrow("cannot be changed from here yet");
  });

  it("keeps the model when the home machine refuses", async () => {
    const f = fixture();
    const backend = await f.open();
    const error = Object.assign(new Error("Unknown"), { code: "unknown-command" });
    f.services.call = vi.fn(async () => { throw error; });
    await expect(backend.capabilities.catalogWrite!.setModel("openai", "gpt-small")).rejects.toThrow("rex runs an older Tau that cannot change models from here yet.");
    expect(backend.catalogView().model).toEqual({ provider: "openai", id: "gpt-test", name: "gpt-test" });
  });
});

describe("a followed machine thread", () => {
  it("starts from the newest transcript and pages backwards in order", async () => {
    const f = fixture();
    const cursor = "remote-cursor" as HostTranscriptCursor;
    f.services.request = vi.fn(async (_machine, _method, params) => params?.[1] === cursor ? page([message("older"), message("old")]) : page([message("old"), message("new")], cursor));
    const backend = await f.open();
    expect(f.services.followThread).toHaveBeenCalledWith(rex.id, "t1", expect.any(Function));
    expect(await backend.transcript()).toEqual([message("older"), message("old"), message("new")]);
    expect(f.services.request).toHaveBeenCalledWith(rex.id, "transcript-page", ["t1", cursor]);
    expect(backend.state()).toMatchObject({ streaming: false, idle: true, title: "Remote work", hasMessages: true });
    expect(backend.catalogView().model).toEqual({ provider: "openai", id: "gpt-test", name: "gpt-test" });
    expect(Object.keys(backend.capabilities)).toEqual(["catalogWrite"]);
    await backend.dispose();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("stops transcript paging at 2000 messages and preserves the newest messages", async () => {
    const f = fixture();
    const cursor = "older" as HostTranscriptCursor;
    f.services.request = vi.fn(async (_machine, _method, params) => params?.[1] ? page(Array.from({ length: 1500 }, (_, i) => message(`old-${i}`)), cursor) : page(Array.from({ length: 1500 }, (_, i) => message(`new-${i}`)), cursor));
    const backend = await f.open();
    const transcript = await backend.transcript();
    expect(transcript).toHaveLength(2000);
    expect(transcript[0]?.id).toBe("old-1000");
    expect(transcript.at(-1)?.id).toBe("new-1499");
    expect(f.services.request).toHaveBeenCalledTimes(2);
  });

  it.each([ ["prompt", undefined, "prompt"], ["steer", undefined, "steer"], ["followUp", undefined, "queue"], ["prompt", true, "queue"] ] as const)("sends %s with queued=%s to the remote id as %s", async (mode, queued, expected) => {
    const f = fixture();
    const backend = await f.open();
    await backend.prompt({ text: "hello", delivery: mode, ...(queued ? { queued } : {}) });
    expect(f.services.request).toHaveBeenLastCalledWith(rex.id, "send-to-thread", ["t1", "hello", expected]);
    await backend.abort();
    expect(f.services.request).toHaveBeenLastCalledWith(rex.id, "abort", ["t1"]);
    expect(await backend.preparePrompt("  hello\n")).toMatchObject({ tauThreadId: backend.threadId, providerSessionId: "t1", visibleText: "  hello\n", runtimeText: "  hello\n", backendKind: "machine" });
  });

  it("refuses files, and unreachable machines, while preserving the last state", async () => {
    const f = fixture();
    const backend = await f.open();
    await expect(backend.prompt({ text: "x", delivery: "prompt", attachments: [{ kind: "file", path: "/Users/me/secret.txt", size: 1, mimeType: "text/plain", name: "secret.txt" }] })).rejects.toThrow("Files stay on this computer; rex takes images only.");
    expect(f.services.call).not.toHaveBeenCalled();
    f.setMachines([{ ...rex, status: "offline" }]);
    const before = backend.state();
    await expect(backend.prompt({ text: "x", delivery: "prompt" })).rejects.toThrow("rex is not reachable right now.");
    expect(backend.state()).toEqual(before);
  });

  it("asks to update an older host on send-to-thread, and keeps ordinary errors unchanged", async () => {
    const f = fixture();
    const backend = await f.open();
    const missing = Object.assign(new Error('Unknown method "send-to-thread".'), { code: "unknown-method" });
    f.services.request = vi.fn(async () => { throw missing; });
    await expect(backend.prompt({ text: "x", delivery: "prompt" })).rejects.toMatchObject({
      code: "unknown-method", message: "rex runs an older Tau that cannot take messages from here yet. Update rex in Settings → Machines.", cause: missing,
    });
    for (const code of ["failed", "unauthorized", "timeout", "unsupported"]) {
      const error = Object.assign(new Error('Unknown method "send-to-thread".'), { code });
      f.services.request = vi.fn(async () => { throw error; });
      // oxlint-disable-next-line no-await-in-loop
      await expect(backend.prompt({ text: "x", delivery: "prompt" })).rejects.toBe(error);
    }
  });

  it("forwards assistant deltas, updates state, and settles each remote turn once", async () => {
    const f = fixture();
    const backend = await f.open();
    f.push({ type: "agent-status", sessionId: "t1", running: true });
    f.push({ type: "host-update", update: { version: 1, type: "run", sessionId: "t1", event: "started" } });
    f.push({ type: "assistant-delta", sessionId: "t1", id: "a", delta: "Hello" });
    await expect.poll(() => backend.state().streaming).toBe(true);
    await expect.poll(() => f.context.onEvent).toHaveBeenCalledWith({ type: "assistant-delta", id: "a", delta: "Hello" });
    f.push({ type: "host-update", update: { version: 1, type: "run", sessionId: "t1", event: "settled" } });
    f.push({ type: "agent-status", sessionId: "t1", running: false });
    await backend.waitForIdle();
    expect(vi.mocked(f.context.onEvent).mock.calls.filter(([event]) => event.type === "turn-started")).toHaveLength(1);
    expect(vi.mocked(f.context.onEvent).mock.calls.filter(([event]) => event.type === "turn-settled")).toEqual([[{ type: "turn-settled", status: "completed" }]]);
  });

  it("recovers compact final messages at turn end without redelivering known messages", async () => {
    const f = fixture();
    const backend = await f.open();
    await backend.transcript();
    f.services.request = vi.fn(async () => page([message("old"), message("new", "full final text")]));
    f.push({ type: "agent-status", sessionId: "t1", running: true });
    f.push({ type: "assistant-end-delta", sessionId: "t1", message: { id: "new", role: "assistant", timestamp: 2 }, after: 3, text: { keep: 2, drop: 0, text: "rest" } });
    f.push({ type: "tool-update-delta", sessionId: "t1", id: "tool", after: 2, keep: 0, drop: 0, text: "out" });
    f.push({ type: "agent-status", sessionId: "t1", running: false });
    await backend.waitForIdle();
    expect(f.context.onMessage).toHaveBeenCalledExactlyOnceWith(message("new", "full final text"));
    expect(f.services.request).toHaveBeenCalledExactlyOnceWith(rex.id, "transcript-page", ["t1", undefined]);
  });

  it("asks locally, sends the remote prompt id and answer, and suppresses already resolved answers", async () => {
    const f = fixture();
    await f.open();
    const prompt = { id: "remote-question", sessionId: "t1", kind: "confirm" as const, title: "Proceed?", message: "Run it" };
    f.push({ type: "extension-ui-prompt", sessionId: "t1", prompt });
    await expect.poll(() => f.services.request).toHaveBeenCalledWith(rex.id, "answer-extension-ui", ["remote-question", { confirmed: true }]);
    expect(f.context.ask).toHaveBeenCalledWith({ kind: "confirm", title: "Proceed?", message: "Run it" });
    let answer!: (value: { confirmed: boolean }) => void;
    f.context.ask = vi.fn(() => new Promise<{ confirmed: boolean }>((resolve) => { answer = resolve; }));
    f.push({ type: "extension-ui-prompt", sessionId: "t1", prompt: { ...prompt, id: "resolved" } });
    await expect.poll(() => f.context.ask).toHaveBeenCalledOnce();
    f.push({ type: "extension-ui-resolved", sessionId: "t1", id: "resolved" });
    await vi.waitFor(() => expect(f.context.ask).toHaveBeenCalledOnce());
    answer({ confirmed: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.services.request).not.toHaveBeenCalledWith(rex.id, "answer-extension-ui", ["resolved", expect.anything()]);
  });

  it("reports error and aborted runs with their status", async () => {
    const f = fixture();
    const backend = await f.open();
    f.push({ type: "agent-status", sessionId: "t1", running: true });
    f.push({ type: "notice", sessionId: "t1", message: "Failed", level: "error" });
    f.push({ type: "agent-status", sessionId: "t1", running: false });
    await backend.waitForIdle();
    expect(f.context.onEvent).toHaveBeenCalledWith({ type: "turn-settled", status: "error", error: "Failed" });
    f.push({ type: "agent-status", sessionId: "t1", running: true });
    f.push({ type: "host-update", update: { version: 1, type: "run", sessionId: "t1", event: "aborted" } });
    await backend.waitForIdle();
    expect(f.context.onEvent).toHaveBeenCalledWith({ type: "turn-settled", status: "interrupted" });
  });
});
