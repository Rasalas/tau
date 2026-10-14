import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeQuery } from "./runtime-adapter.js";
import { SdkTurnTranslator } from "./sdk-events.js";
import { ClaudeSdkSession } from "./sdk-session.js";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const frame = <T extends object>(value: T): SDKMessage => ({ uuid: "u", session_id: SESSION, ...value }) as unknown as SDKMessage;
const init = () => frame({ type: "system", subtype: "init", model: "claude-opus-5" });
const assistant = (text: string) => frame({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
const result = (uuids: string[], numTurns = 1) => frame({ type: "result", subtype: "success", is_error: false, num_turns: numTurns, result: "", user_message_uuids: uuids, user_message_uuid: uuids.at(-1) });

interface Script {
  /** Frames to yield for a user message; `null` keeps the message for the next batch (a steer that joins the turn). */
  (message: SDKUserMessage, held: SDKUserMessage[]): SDKMessage[] | null;
}

/** A `query` that reads the prompt iterable like the CLI: one turn per message, or one per batch. */
function sessionQuery(script: Script, prelude: SDKMessage[] = [init()]) {
  const received: SDKUserMessage[] = [];
  let abort: AbortSignal | undefined;
  const control = { interrupt: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined) };
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    abort = params.options?.abortController?.signal;
    async function* run(): AsyncGenerator<SDKMessage, void> {
      for (const message of prelude) yield message;
      const held: SDKUserMessage[] = [];
      for await (const message of params.prompt) {
        received.push(message);
        const frames = script(message, held);
        if (frames === null) { held.push(message); continue; }
        held.length = 0;
        for (const out of frames) {
          if (abort?.aborted) throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
          yield out;
        }
      }
    }
    return Object.assign(run(), control) as unknown as ReturnType<ClaudeQuery>;
  }) as unknown as ClaudeQuery;
  return { query, received, control, aborted: () => abort?.aborted ?? false };
}

function open(query: ClaudeQuery) {
  const seen: string[] = [];
  const exits: unknown[] = [];
  const session = new ClaudeSdkSession({ query, options: { cwd: "/repo" }, claudeSessionId: SESSION, onMessage: (message) => { seen.push(message.type); }, onExit: (error) => { exits.push(error); } });
  session.start();
  return { session, seen, exits };
}

describe("ClaudeSdkSession", () => {
  it("preserves a thrown 403 error without adding a login hint", async () => {
    const detail = "Failed to authenticate. API Error: 403 Your organization does not have access to this model.";
    const { query, aborted } = sessionQuery(() => { throw new Error(detail); });
    const { session, exits } = open(query);
    await expect(session.send("hello", "next")).rejects.toThrow(new Error(detail));
    expect((exits[0] as Error).message).toBe(detail);
    expect(aborted()).toBe(false);
  });

  it.each(["Invalid API key", "Please sign in", "API Error: 401 Unauthorized"])("still aborts immediately on an explicit login error: %s", async (detail) => {
    const { query, aborted } = sessionQuery(() => [
      frame({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: detail }] } }),
    ]);
    const { session } = open(query);
    await expect(session.send("hello", "next")).rejects.toThrow("Sign in again");
    expect(session.closed).toBe(true);
    expect(aborted()).toBe(true);
  });

  it("uses a 401 result to identify an ambiguous assistant error as a login failure", async () => {
    const { query, aborted } = sessionQuery((message) => [
      frame({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Could not complete this request." }] } }),
      frame({ type: "result", subtype: "success", is_error: true, api_error_status: 401, num_turns: 1, result: "Request rejected.", user_message_uuids: [message.uuid] }),
    ]);
    const { session, exits, seen } = open(query);
    await expect(session.send("hello", "next")).resolves.toMatchObject({ api_error_status: 401 });
    expect(seen).toEqual(["system", "assistant", "result"]);
    expect((exits[0] as Error).message).toContain("Sign in again");
    expect(session.closed).toBe(true);
    expect(aborted()).toBe(true);
  });

  it("reports a thrown authentication failure with a login hint and aborts the session", async () => {
    const { query, aborted } = sessionQuery(() => { throw new Error("Failed to authenticate: OAuth session expired and could not be refreshed"); });
    const { session, exits } = open(query);
    await expect(session.send("hello", "next")).rejects.toThrow("claude auth login");
    expect(session.closed).toBe(true);
    expect(aborted()).toBe(true);
    expect(exits[0]).toMatchObject({ name: "ClaudeAuthenticationError" });
  });

  it("keeps the session available when ordinary replies or tool errors discuss an expired login", async () => {
    const { query, aborted } = sessionQuery((message) => [
      assistant("Failed to authenticate: OAuth session expired and could not be refreshed"),
      frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "shell", is_error: true, content: "Not logged in. Please run /login" }] } }),
      result([message.uuid!]),
    ]);
    const { session } = open(query);
    await session.send("Check the service's login", "next");
    expect(session.closed).toBe(false);
    expect(aborted()).toBe(false);
    await session.close();
  });

  it.each([null, "agent-call"])("ends the entire session on an authentication failure from %s without waiting for a result", async (parent) => {
    const { query, aborted, received } = sessionQuery(() => [
      frame({ type: "assistant", parent_tool_use_id: parent, error: "authentication_failed", message: { role: "assistant", content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] } }),
      assistant("Must never run"),
    ]);
    const { session, exits, seen } = open(query);
    const pending = session.send("Delegate", "next");
    const queued = session.send("Queued", "later");
    try {
      await expect(pending).rejects.toThrow(/sign in|log in|login/iu);
      await expect(queued).rejects.toThrow(/sign in|log in|login/iu);
      expect(session.closed).toBe(true);
      expect(session.busy).toBe(false);
      expect(aborted()).toBe(true);
      expect(received).toHaveLength(1);
      expect(seen).toEqual(["system", "assistant"]);
      expect(exits).toHaveLength(1);
    } finally { await session.close(); }
  }, 2_000);

  it("settles each send with the result that consumed it, in order", async () => {
    const { query, received } = sessionQuery((message) => [assistant(`re: ${JSON.stringify(message.message.content)}`), result([message.uuid!])]);
    const { session, seen } = open(query);
    const first = await session.send("one", "next");
    expect(first.type).toBe("result");
    expect(session.busy).toBe(false);
    const second = session.send("two", "later");
    expect(session.busy).toBe(true);
    await second;
    expect(received.map((message) => [message.message.content, message.priority, message.session_id])).toEqual([["one", "next", SESSION], ["two", "later", SESSION]]);
    expect(received.every((message) => typeof message.uuid === "string")).toBe(true);
    expect(seen).toEqual(["system", "assistant", "result", "assistant", "result"]);
  });

  it("resolves a steer with the turn it joined, not with a turn of its own", async () => {
    const { query } = sessionQuery((message, held) => held.length === 0 && message.message.content !== "go"
      ? null
      : [assistant("done"), result([...held.map((entry) => entry.uuid!), message.uuid!])]);
    const { session } = open(query);
    // The CLI merges a message that arrives close to another into one turn.
    const steer = session.send("also this", "next");
    const turn = session.send("go", "next");
    const [steerResult, turnResult] = await Promise.all([steer, turn]);
    expect(steerResult).toBe(turnResult);
  });

  it.each([undefined, { kind: "human" }])("ignores the resume handshake and falls back to the oldest send with origin %j", async (origin) => {
    const { query } = sessionQuery(() => [assistant("ok"), frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "", ...(origin ? { origin } : {}) })], [init(), result([], 0)]);
    const { session } = open(query);
    await expect(session.send("hello", "next")).resolves.toMatchObject({ type: "result", num_turns: 1 });
  });

  it.each(["user", "compact"])("keeps the %s turn open past unrelated background results", async (kind) => {
    const translator = new SdkTurnTranslator(() => 42, () => "assistant", kind === "compact");
    const outcomes: unknown[] = [];
    const unclaimed: unknown[] = [];
    const { query } = sessionQuery((message) => [
      assistant("working"),
      result(["a-different-prompt"]),
      frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "background", origin: { kind: "task-notification" } }),
      ...(kind === "compact" ? [frame({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 100, post_tokens: 10 } })] : []),
      result([message.uuid!], kind === "compact" ? 0 : 1),
    ]);
    const session = new ClaudeSdkSession({ query, options: { cwd: "/repo" }, claudeSessionId: SESSION,
      onMessage: (message, background) => {
        // The backend hands these to a turn the CLI began itself, never to Tau's.
        if (background) return void unclaimed.push(message);
        translator.push(message);
        if (message.type === "result") outcomes.push(translator.outcome);
      }, onExit: () => undefined });
    session.start();
    await session.send(kind === "compact" ? "/compact" : "hello", "next");
    expect(outcomes).toHaveLength(1);
    expect(unclaimed).toHaveLength(2);
    expect(translator.outcome).toMatchObject(kind === "compact" ? { compacted: true } : { texts: ["working"] });
    await session.close();
  });

  it("accepts the singular prompt UUID even when the plural list is empty", async () => {
    const { query } = sessionQuery((message) => [frame({
      type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done",
      user_message_uuids: [], user_message_uuid: message.uuid, origin: { kind: "task-notification" },
    })]);
    const { session, seen } = open(query);
    await expect(session.send("hello", "next")).resolves.toMatchObject({ result: "done" });
    expect(seen).toEqual(["system", "result"]);
    await session.close();
  });

  it("preserves legacy local command results with zero turns", async () => {
    const { query } = sessionQuery(() => [frame({
      type: "result", subtype: "success", is_error: false, num_turns: 0, result: "", local_command: "compact",
    })]);
    const { session } = open(query);
    await expect(session.send("/compact", "next")).resolves.toMatchObject({ num_turns: 0 });
    await session.close();
  });

  it("rejects pending sends and reports the exit when the session closes or the CLI dies", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hanging = sessionQuery(() => []);
    const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
      const inner = hanging.query(params) as AsyncGenerator<SDKMessage>;
      async function* run(): AsyncGenerator<SDKMessage, void> {
        yield init();
        await gate;
        yield* inner;
      }
      return Object.assign(run(), hanging.control) as unknown as ReturnType<ClaudeQuery>;
    }) as unknown as ClaudeQuery;
    const { session, exits } = open(query);
    const pending = session.send("wait", "next");
    // Closing waits for the loop; the loop is parked on the gate until released.
    const closing = session.close();
    release();
    await closing;
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(session.closed).toBe(true);
    expect(exits).toEqual([undefined]);
    await expect(session.send("after", "next")).rejects.toMatchObject({ name: "AbortError" });

    const dying = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      async function* run(): AsyncGenerator<SDKMessage, void> {
        yield init();
        for await (const received of params.prompt) {
          void received;
          throw new Error("process exited with code 1");
        }
      }
      return Object.assign(run(), { interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn() }) as unknown as ReturnType<ClaudeQuery>;
    }) as unknown as ClaudeQuery;
    const crashed = open(dying);
    await expect(crashed.session.send("boom", "next")).rejects.toThrow("process exited with code 1");
    expect(crashed.exits).toHaveLength(1);
    expect((crashed.exits[0] as Error).message).toBe("process exited with code 1");
  });

  it("reports the reason explainExit names in place of the SDK's error, for the pending send and the owner", async () => {
    const dying = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      async function* run(): AsyncGenerator<SDKMessage, void> {
        yield init();
        for await (const received of params.prompt) {
          void received;
          throw new Error("process exited with code 137");
        }
      }
      return Object.assign(run(), { interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn() }) as unknown as ReturnType<ClaudeQuery>;
    }) as unknown as ClaudeQuery;
    const exits: unknown[] = [];
    const session = new ClaudeSdkSession({ query: dying, options: { cwd: "/repo" }, claudeSessionId: SESSION, onMessage: () => undefined, onExit: (error) => { exits.push(error); }, explainExit: async () => new Error("Killed: out of memory.") });
    session.start();
    await expect(session.send("boom", "next")).rejects.toThrow("Killed: out of memory.");
    expect((exits[0] as Error).message).toBe("Killed: out of memory.");
  });

  it("forwards interrupt and permission-mode changes to the live query", async () => {
    const { query, control } = sessionQuery(() => []);
    const { session } = open(query);
    await session.interrupt();
    await session.setPermissionMode("plan");
    expect(control.interrupt).toHaveBeenCalled();
    expect(control.setPermissionMode).toHaveBeenCalledWith("plan");
    await session.close();
  });
});
