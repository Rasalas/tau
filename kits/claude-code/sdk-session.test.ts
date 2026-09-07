import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeQuery } from "./runtime-adapter.js";
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
    const { query } = sessionQuery((message, held) => message.priority === "now" && held.length === 0 && message.message.content !== "go"
      ? null
      : [assistant("done"), result([...held.map((entry) => entry.uuid!), message.uuid!])]);
    const { session } = open(query);
    // The CLI merges a message that arrives close to another into one turn.
    const steer = session.send("also this", "now");
    const turn = session.send("go", "next");
    const [steerResult, turnResult] = await Promise.all([steer, turn]);
    expect(steerResult).toBe(turnResult);
  });

  it("ignores the resume handshake and falls back to the oldest send when a result names nothing", async () => {
    const { query } = sessionQuery(() => [assistant("ok"), frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "" })], [init(), result([], 0)]);
    const { session } = open(query);
    await expect(session.send("hello", "next")).resolves.toMatchObject({ type: "result", num_turns: 1 });
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
