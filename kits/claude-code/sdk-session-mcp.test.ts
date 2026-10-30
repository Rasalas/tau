import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { McpSetServersResult, Options, SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeQuery } from "./runtime-adapter.js";
import { ClaudeSdkSession } from "./sdk-session.js";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const STALE_AUTH = "11111111-1111-4111-8111-111111111111";
const TOKEN = "dummy-mcp-credential";
const servers = { tau: { type: "http" as const, url: "http://127.0.0.1/mcp", headers: { Authorization: `Bearer ${TOKEN}` } } };
const registered = (): McpSetServersResult => ({ added: ["tau"], removed: [], errors: {} });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Reads the actual prompt iterator, including stale iterators still waiting when a CLI is disposed. */
function harness(registrations: Array<() => Promise<McpSetServersResult>>, options: Options = { resume: SESSION }, disposal: (index: number) => Promise<void> = async () => undefined, prelude: SDKMessage[] = []) {
  const attempts: Array<{ options: Options; prompt: AsyncIterable<SDKUserMessage>; received: SDKUserMessage[]; dispose: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn> }> = [];
  const query = vi.fn((params: Parameters<ClaudeQuery>[0]) => {
    if (typeof params.prompt === "string") throw new Error("Expected streaming input");
    const index = attempts.length;
    const received: SDKUserMessage[] = [];
    const opts = params.options!;
    const prompt = params.prompt;
    const dispose = vi.fn(() => disposal(index));
    const register = vi.fn(registrations[index] ?? (() => Promise.resolve(registered())));
    attempts.push({ options: opts, prompt, received, dispose, register });
    opts.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal: opts.abortController!.signal });
    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: SESSION, uuid: `init-${index}` } as SDKMessage;
      for (const frame of prelude) yield frame;
      for await (const message of prompt) {
        received.push(message);
        yield { type: "result", subtype: "success", session_id: SESSION, uuid: `result-${message.uuid}`, is_error: false, num_turns: 1, result: "ok", user_message_uuids: [message.uuid] } as SDKMessage;
      }
      // A closing CLI can still drain frames already buffered on stdout.
      yield { type: "assistant", session_id: SESSION, uuid: STALE_AUTH, error: "authentication_failed", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "API Error: 401 Unauthorized" }] } } as unknown as SDKMessage;
    }
    return Object.assign(run(), {
      setMcpServers: register, [Symbol.asyncDispose]: dispose,
      setModel: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined), applyFlagSettings: vi.fn(async () => undefined),
    }) as unknown as ReturnType<ClaudeQuery>;
  }) as ClaudeQuery;
  const exits: unknown[] = [];
  const unavailable: unknown[] = [];
  const messages: SDKMessage[] = [];
  const session = new ClaudeSdkSession({
    query, options, claudeSessionId: SESSION, mcpServers: servers, mcpTimeoutMs: 10,
    onMessage: (message) => { messages.push(message); }, onExit: (error) => { exits.push(error); },
    onMcpUnavailable: (...notice) => { unavailable.push(notice); },
  });
  session.start();
  return { session, attempts, exits, unavailable, messages };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("resumed Claude MCP registration", () => {
  it("disposes before reopening, keeps queued sends and priorities, and never feeds the retired CLI", async () => {
    const first = deferred<McpSetServersResult>();
    const cleanup = deferred<void>();
    const { session, attempts, exits, unavailable, messages } = harness([() => first.promise, async () => registered()], { resume: SESSION }, (index) => index === 0 ? cleanup.promise : Promise.resolve());
    const one = session.send("continue", "next");
    const two = session.send("follow-up", "later");
    try {
      await session.setModel("sonnet");
      await session.setPermissionMode("plan");
      await session.setEffort("high");
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.dispose).toHaveBeenCalledTimes(1);
      expect(attempts[0]!.options.abortController!.signal.aborted).toBe(true);
      expect(attempts[0]!.received).toEqual([]);
      const three = session.send("steer during cleanup", "next");
      // Late SDK failures often echo headers. They must not exit the replacement or reach notices.
      first.reject(new Error(`registration failed: Bearer ${TOKEN}`));
      cleanup.resolve();
      await flush();
      await Promise.all([one, two, three]);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((entry) => entry.options.resume)).toEqual([SESSION, SESSION]);
      expect(attempts[1]!.options).toMatchObject({ model: "sonnet", permissionMode: "plan", effort: "high" });
      expect(attempts[1]!.options.abortController).not.toBe(attempts[0]!.options.abortController);
      expect(attempts[1]!.register).toHaveBeenCalledExactlyOnceWith(servers);
      expect(attempts[1]!.received.map((message) => [message.message.content, message.priority])).toEqual([["continue", "next"], ["follow-up", "later"], ["steer during cleanup", "next"]]);
      expect(new Set(attempts[1]!.received.map((message) => message.uuid)).size).toBe(3);
      expect(await attempts[0]!.prompt[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
      expect(attempts.every((entry) => entry.options.mcpServers === undefined)).toBe(true);
      expect(exits).toEqual([]);
      expect(unavailable).toEqual([]);
      expect(session.abortController.signal.aborted).toBe(false);
      expect(messages.some((frame) => frame.uuid === STALE_AUTH)).toBe(false);
    } finally { cleanup.resolve(); await session.close(); }
    expect(attempts.map((entry) => entry.dispose.mock.calls.length)).toEqual([1, 1]);
    expect(exits).toEqual([undefined]);
  });

  it("does not let a legacy resume result settle a queued send before registration", async () => {
    const handshake = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "old result", session_id: SESSION, uuid: "old" } as unknown as SDKMessage;
    const { session } = harness([() => new Promise(() => {}), async () => registered()], { resume: SESSION }, async () => undefined, [handshake]);
    const sent = session.send("continue", "next");
    let settled = false;
    void sent.then(() => { settled = true; }, () => { settled = true; });
    try {
      await flush();
      expect(settled).toBe(false);
      expect(session.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(await sent).toMatchObject({ result: "ok" });
    } finally { await session.close(); }
  });

  it("does not reopen when closed during disposal of the first attempt", async () => {
    const cleanup = deferred<void>();
    const { session, attempts, exits } = harness([() => new Promise(() => {})], { resume: SESSION }, () => cleanup.promise);
    const sent = session.send("continue", "next").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    const closing = session.close();
    cleanup.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(100);
    expect(await sent).toMatchObject({ name: "AbortError" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.received).toEqual([]);
    expect(exits).toEqual([undefined]);
  });

  it("stops after the second timeout and settles all sends through the existing session error route", async () => {
    const { session, attempts, exits, unavailable } = harness([() => new Promise(() => {}), () => new Promise(() => {})]);
    const failures = [session.send("one", "next"), session.send("two", "later")].map((send) => send.catch((error: unknown) => error));
    try {
      await vi.advanceTimersByTimeAsync(20);
      const errors = await Promise.all(failures);
      expect(errors[0]).toMatchObject({ name: "ClaudeMcpRegistrationTimeoutError", message: expect.stringContaining("Retry the turn") });
      expect(errors[1]).toBe(errors[0]);
      expect(exits).toEqual([errors[0]]);
      expect(attempts).toHaveLength(2);
      expect(attempts.every((entry) => entry.received.length === 0 && entry.options.abortController!.signal.aborted)).toBe(true);
      expect(attempts.map((entry) => entry.dispose.mock.calls.length)).toEqual([1, 1]);
      expect(unavailable).toEqual([]);
      expect(JSON.stringify(errors)).not.toContain(TOKEN);
      expect(session.closed).toBe(true);
      expect(session.busy).toBe(false);
    } finally { await session.close(); }
  });

  it.each(["close", "abort"])("cancels stalled registration via %s without retrying or releasing the prompt", async (action) => {
    const first = deferred<McpSetServersResult>();
    const { session, attempts, exits, unavailable } = harness([() => first.promise]);
    const failure = session.send("must not run", "next").catch((error: unknown) => error);
    await flush();
    if (action === "close") await session.close();
    else { session.abortController.abort(); await flush(); }
    first.resolve(registered());
    await vi.advanceTimersByTimeAsync(100);
    expect(await failure).toMatchObject({ name: "AbortError" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.received).toEqual([]);
    expect(attempts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(unavailable).toEqual([]);
    expect(exits).toEqual([undefined]);
    await session.close();
  });

  it("does not reuse a fresh session ID after a timeout", async () => {
    const { session, attempts, unavailable } = harness([() => new Promise(() => {})], { sessionId: SESSION });
    try {
      const sent = session.send("fresh", "next");
      await vi.advanceTimersByTimeAsync(10);
      await sent;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.received).toHaveLength(1);
      expect(unavailable).toEqual([[["tau"], "timeout"]]);
    } finally { await session.close(); }
  });

  it("keeps answered registration failures sanitized and does not retry them", async () => {
    const { session, attempts, unavailable } = harness([async () => { throw new Error(`rejected ${TOKEN}`); }]);
    try {
      await session.send("still run", "next");
      expect(attempts).toHaveLength(1);
      expect(unavailable).toEqual([[["tau"], "failed"]]);
    } finally { await session.close(); }
  });

  it("aborts in-flight permission and dialog hooks and refuses stale callback invocations", async () => {
    const tool = deferred<Awaited<ReturnType<NonNullable<Options["canUseTool"]>>>>();
    const dialog = deferred<Awaited<ReturnType<NonNullable<Options["onUserDialog"]>>>>();
    let toolSignal: AbortSignal | undefined;
    let dialogSignal: AbortSignal | undefined;
    const options: Options = { resume: SESSION,
      canUseTool: vi.fn((_name, _input, context) => { toolSignal = context.signal; return tool.promise; }),
      onUserDialog: vi.fn((_request, context) => { dialogSignal = context.signal; return dialog.promise; }),
    };
    const { session, attempts } = harness([() => new Promise(() => {}), async () => registered()], options);
    try {
      const stale = attempts[0]!.options;
      const context = { signal: new AbortController().signal, toolUseID: "tool", requestId: "request" };
      const toolResult = stale.canUseTool!("Bash", {}, context).catch((error: unknown) => error);
      const dialogResult = stale.onUserDialog!({ dialogKind: "resume_return", payload: {} }, context).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(toolSignal!.aborted).toBe(true);
      expect(dialogSignal!.aborted).toBe(true);
      tool.resolve({ behavior: "allow", updatedInput: {} });
      dialog.resolve(null);
      expect(await toolResult).toMatchObject({ name: "AbortError" });
      expect(await dialogResult).toMatchObject({ name: "AbortError" });
      await expect(stale.canUseTool!("Bash", {}, context)).rejects.toMatchObject({ name: "AbortError" });
      await expect(stale.onUserDialog!({ dialogKind: "resume_return", payload: {} }, context)).rejects.toMatchObject({ name: "AbortError" });
      expect(options.canUseTool).toHaveBeenCalledTimes(1);
      expect(options.onUserDialog).toHaveBeenCalledTimes(1);
      await session.send("resume", "next");
    } finally { await session.close(); }
  });

  it("refuses to reopen after failed disposal and keeps credential-bearing cleanup errors private", async () => {
    const { session, attempts, exits } = harness([() => new Promise(() => {})], { resume: SESSION }, async () => { throw new Error(`cleanup echoed ${TOKEN}`); });
    const pending = session.send("continue", "next").catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(10);
      const error = await pending;
      expect(error).toMatchObject({ message: expect.stringContaining("could not stop its previous session") });
      expect(String(error)).not.toContain(TOKEN);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.received).toEqual([]);
      expect(exits).toEqual([error]);
    } finally { await session.close(); }
  });

  it.each([true, false])("requires confirmed process exit before retrying, exits=%s", async (exits) => {
    const events = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    const child = Object.assign(events, { stdin: input, stdout: output, killed: false, exitCode: null, kill: vi.fn(() => true) }) satisfies SpawnedProcess;
    const { session, attempts } = harness([() => new Promise(() => {}), async () => registered()], { resume: SESSION, spawnClaudeCodeProcess: () => child });
    const pending = session.send("one", "next").catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(attempts).toHaveLength(1);
      if (exits) {
        child.emit("exit", null, "SIGKILL");
        await flush();
        expect(attempts).toHaveLength(2);
        expect(await pending).toMatchObject({ subtype: "success" });
        // The replacement is also tracked by this fixture's spawner.
        child.emit("exit", 0, null);
      } else {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await pending).toMatchObject({ message: expect.stringContaining("could not stop its previous session") });
        expect(attempts).toHaveLength(1);
      }
    } finally {
      await session.close();
      input.destroy(); output.destroy();
    }
    expect(events.listenerCount("exit")).toBe(0);
  });
});
