import { describe, expect, it } from "vitest";
import type { HostPushEvent } from "../shared/host-transport.js";
import { HostPushCoalescer, type CoalescerClock } from "./host-push-coalescer.js";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol.js";
import { INLINE_TOOL_OUTPUT_CHARS, LIVE_TOOL_OUTPUT_MARKER, liveToolOutput } from "./client-tool-output.js";

/** Timers that run only when the test says so. */
function manualClock(): CoalescerClock & { fire(): void; pending(): number } {
  let timers: Array<() => void> = [];
  return {
    setTimeout: (callback) => { timers.push(callback); return callback; },
    clearTimeout: (handle) => { timers = timers.filter((timer) => timer !== handle); },
    fire: () => { const due = timers; timers = []; for (const timer of due) timer(); },
    pending: () => timers.length,
  };
}

function setup() {
  const clock = manualClock();
  const recorded: HostPushEvent[] = [];
  const coalescer = new HostPushCoalescer((event) => { recorded.push(event); return recorded.length; }, { clock });
  return { clock, recorded, coalescer };
}

const delta = (id: string, text: string): HostPushEvent => ({ type: "assistant-delta", sessionId: "s", id, delta: text });
const update = (output: string, id = "t1"): HostPushEvent => ({ type: "tool-update", sessionId: "s", id, output });
const log = (label: string): HostPushEvent => ({ type: "event-log", label, timestamp: 0 });
const tool = { id: "t1", name: "bash", args: {}, status: "done" as const, startedAt: 0 };

describe("HostPushCoalescer", () => {
  it("joins a message's text deltas until the window closes", () => {
    const { clock, recorded, coalescer } = setup();
    coalescer.publish(delta("a", "Hel"));
    coalescer.publish(delta("a", "lo"));
    coalescer.publish({ type: "assistant-thinking", sessionId: "s", id: "a", delta: "hm" });
    expect(recorded).toEqual([]);
    clock.fire();
    expect(recorded).toEqual([delta("a", "Hello"), { type: "assistant-thinking", sessionId: "s", id: "a", delta: "hm" }]);
    expect(clock.pending()).toBe(0);
  });

  it("pushes what waits before any other event, so the order holds", () => {
    const { clock, recorded, coalescer } = setup();
    coalescer.publish(delta("a", "one"));
    coalescer.publish({ type: "assistant-end", sessionId: "s", message: { id: "a", role: "assistant", text: "one", timestamp: 0 } });
    coalescer.publish(delta("b", "two"));
    expect(recorded.map((event) => event.type)).toEqual(["assistant-delta", "assistant-end"]);
    expect(clock.pending()).toBe(1);
    coalescer.flush();
    expect(recorded.at(-1)).toEqual(delta("b", "two"));
    expect(clock.pending()).toBe(0);
  });

  it("keeps only a tool's latest output and sends later ones as deltas against it", () => {
    const { clock, recorded, coalescer } = setup();
    const base = "x".repeat(100);
    coalescer.publish(update(`${base}1`));
    coalescer.publish(update(`${base}12`));
    clock.fire();
    coalescer.publish(update(`${base}123`));
    clock.fire();
    // The same output again is not news.
    coalescer.publish(update(`${base}123`));
    clock.fire();
    expect(recorded).toEqual([
      update(`${base}12`),
      { type: "tool-update-delta", sessionId: "s", id: "t1", after: 1, keep: 102, drop: 0, text: "3" },
    ]);
  });

  it("starts a tool over whole after it ends, after its run settles, and for a client that starts from a snapshot", () => {
    const { clock, recorded, coalescer } = setup();
    const base = "y".repeat(100);
    coalescer.publish(update(base));
    coalescer.publish({ type: "tool-end", sessionId: "s", tool: { ...tool, output: base } });
    coalescer.publish(update(`${base}a`));
    clock.fire();
    coalescer.resendWholeOutputs();
    coalescer.publish(update(`${base}ab`));
    clock.fire();
    coalescer.publish({ type: "agent-status", sessionId: "s", running: false });
    coalescer.publish(update(`${base}abc`));
    clock.fire();
    expect(recorded.filter((event) => event.type === "tool-update-delta")).toEqual([]);
    expect(recorded.filter((event) => event.type === "tool-update")).toHaveLength(4);
  });

  it("sends whole again only the outputs of threads a client just started to show", () => {
    const { clock, recorded, coalescer } = setup();
    const other: HostPushEvent = { type: "tool-update", sessionId: "o", id: "t9", output: "x".repeat(100) };
    coalescer.publish(update("x".repeat(100)));
    coalescer.publish(other);
    clock.fire();
    coalescer.resendWholeOutputs(["s"]);
    coalescer.publish(update(`${"x".repeat(100)}a`));
    coalescer.publish({ ...other, output: `${"x".repeat(100)}b` });
    clock.fire();
    expect(recorded.slice(2).map((event) => event.type)).toEqual(["tool-update", "tool-update-delta"]);
  });

  it("keeps tools and messages apart", () => {
    const { clock, recorded, coalescer } = setup();
    coalescer.publish(update("first", "t1"));
    coalescer.publish(delta("a", "x"));
    coalescer.publish(update("second", "t2"));
    coalescer.publish(delta("a", "y"));
    coalescer.publish(log("tick"));
    expect(recorded).toEqual([update("first", "t1"), delta("a", "xy"), update("second", "t2"), log("tick")]);
    expect(clock.pending()).toBe(0);
  });

  it("ends a tool with a reference to the output it streamed", () => {
    const { clock, recorded, coalescer } = setup();
    const base = "z".repeat(100);
    coalescer.publish(update(base));
    clock.fire();
    coalescer.publish({ type: "tool-end", sessionId: "s", tool: { ...tool, output: base } });
    coalescer.publish(update(`${base}!`, "t2"));
    clock.fire();
    coalescer.publish({ type: "tool-end", sessionId: "s", tool: { ...tool, id: "t2", output: `${base}!\ndone` } });
    expect(recorded.slice(1, 2)).toEqual([
      { type: "tool-end-delta", sessionId: "s", tool, after: 1, length: 100, keep: 100, drop: 0, text: "" },
    ]);
    expect(recorded.at(-1)).toEqual({ type: "tool-end-delta", sessionId: "s", tool: { ...tool, id: "t2" }, after: 3, length: 106, keep: 101, drop: 0, text: "\ndone" });
  });

  it("ends a tool whole when it streamed nothing, and after a client started from a snapshot", () => {
    const { clock, recorded, coalescer } = setup();
    coalescer.publish({ type: "tool-end", sessionId: "s", tool: { ...tool, output: "quiet" } });
    coalescer.publish(update("x".repeat(100), "t2"));
    clock.fire();
    coalescer.resendWholeOutputs();
    coalescer.publish({ type: "tool-end", sessionId: "s", tool: { ...tool, id: "t2", output: "x".repeat(100) } });
    expect(recorded.filter((event) => event.type === "tool-end")).toHaveLength(2);
    expect(recorded.filter((event) => event.type === "tool-end-delta")).toEqual([]);
  });

  it("streams a long output's live tail and ends it without the output", () => {
    const { clock, recorded, coalescer } = setup();
    const long = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");
    expect(long.length).toBeGreaterThan(INLINE_TOOL_OUTPUT_CHARS);
    coalescer.publish(update(long));
    clock.fire();
    coalescer.publish(update(`${long}\nmore`));
    clock.fire();
    coalescer.publish({ type: "tool-end", sessionId: "s", tool: { ...tool, output: `${long}\nmore` } });
    expect(recorded[0]).toEqual(update(liveToolOutput(long)));
    expect((recorded[0] as { output: string }).output.startsWith(LIVE_TOOL_OUTPUT_MARKER)).toBe(true);
    expect(recorded[1]).toMatchObject({ type: "tool-update-delta", after: 1, text: "\nmore" });
    expect(recorded[2]).toEqual({ type: "tool-end", sessionId: "s", tool: { ...tool, outputDeferred: true, outputLength: long.length + 5 } });
  });

  it("sends a settled detail's turn activity once, inside its history", () => {
    const { recorded, coalescer } = setup();
    const tools = [{ ...tool, output: "ok" }];
    const detail = (turnActivity: unknown) => ({
      type: "host-update" as const,
      update: {
        version: HOST_PROTOCOL_VERSION,
        type: "thread-detail" as const,
        detail: {
          threadId: "s", sessionId: "s", messages: [], isStreaming: false, activeTools: [], taskHistory: [],
          turnActivity,
          turnActivityHistory: [{ id: "a1", anchorMessageId: "m1", status: "completed" as const, tools }],
        },
      },
    }) as HostPushEvent;
    coalescer.publish(detail({ tools, anchorMessageId: "m1" }));
    coalescer.publish(detail({ tools: [{ ...tool, status: "running" }], anchorMessageId: "m1" }));
    expect(recorded[0]).toMatchObject({ type: "thread-detail-compact", activityFromHistory: true });
    expect((recorded[0] as { update: { detail: object } }).update.detail).not.toHaveProperty("turnActivity");
    expect(recorded[1]).toEqual(detail({ tools: [{ ...tool, status: "running" }], anchorMessageId: "m1" }));
  });

  describe("message text", () => {
    const LONG = "The answer, long enough that referring to it costs less than sending it.";
    const start = (id = "a"): HostPushEvent => ({ type: "assistant-start", sessionId: "s", id, timestamp: 1 });
    const end = (text: string, extra: object = {}, id = "a"): HostPushEvent => ({ type: "assistant-end", sessionId: "s", message: { id, role: "assistant", text, timestamp: 1, ...extra } });
    const detail = (messages: unknown[]): HostPushEvent => ({
      type: "host-update",
      update: { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: { sessionId: "s", messages, isStreaming: false, activeTools: [] } },
    }) as HostPushEvent;

    it("ends a message with a reference to the text it streamed", () => {
      const { clock, recorded, coalescer } = setup();
      coalescer.publish(start());
      coalescer.publish({ type: "assistant-thinking", sessionId: "s", id: "a", delta: "plan\n\n" });
      coalescer.publish(delta("a", LONG));
      clock.fire();
      coalescer.publish(end(`${LONG}!`, { thinking: "plan" }));
      expect(recorded.at(-1)).toEqual({
        type: "assistant-end-delta",
        sessionId: "s",
        message: { id: "a", role: "assistant", timestamp: 1 },
        after: 3,
        text: { keep: LONG.length, drop: 0, text: "!" },
        thinking: { keep: 4, drop: 2, text: "" },
      });
    });

    it("ends a message whole when it never streamed, is short, or a client started from a snapshot", () => {
      const { clock, recorded, coalescer } = setup();
      coalescer.publish(end(LONG));
      coalescer.publish(start("b"));
      coalescer.publish(delta("b", "Short"));
      clock.fire();
      coalescer.publish(end("Short", {}, "b"));
      coalescer.publish(start("c"));
      coalescer.publish(delta("c", LONG));
      clock.fire();
      coalescer.resendWholeOutputs();
      coalescer.publish(end(LONG, {}, "c"));
      expect(recorded.filter((event) => event.type === "assistant-end")).toEqual([end(LONG), end("Short", {}, "b"), end(LONG, {}, "c")]);
    });

    it("sends a detail's ended messages as references to the push that ended them", () => {
      const { clock, recorded, coalescer } = setup();
      coalescer.publish(start());
      coalescer.publish(delta("a", LONG));
      clock.fire();
      coalescer.publish(end(LONG, { thinking: "plan" }));
      coalescer.publish({ type: "assistant-anchor", sessionId: "s", id: "a", sourceEntryId: "e1", timestamp: 1 });
      const user = { id: "u", role: "user", text: "Hi", timestamp: 0 };
      coalescer.publish(detail([user, { id: "e1", sourceEntryId: "e1", role: "assistant", text: LONG, thinking: "plan", timestamp: 1 }]));
      expect(recorded.at(-1)).toEqual({
        type: "thread-detail-compact",
        update: { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: {
          sessionId: "s", isStreaming: false, activeTools: [],
          messages: [user, { id: "e1", sourceEntryId: "e1", role: "assistant", text: "", timestamp: 1 }],
        } },
        texts: { e1: 3 },
      });
      // A text that changed since, or a new turn, travels whole.
      coalescer.publish(detail([{ id: "e1", role: "assistant", text: `${LONG}, edited`, timestamp: 1 }]));
      expect(recorded.at(-1)).toMatchObject({ type: "host-update" });
      coalescer.publish({ type: "agent-status", sessionId: "s", running: true });
      coalescer.publish(detail([{ id: "e1", role: "assistant", text: LONG, thinking: "plan", timestamp: 1 }]));
      expect(recorded.at(-1)).toMatchObject({ type: "host-update" });
    });
  });
});
