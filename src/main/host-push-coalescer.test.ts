import { describe, expect, it } from "vitest";
import type { HostPushEvent } from "../shared/host-transport.js";
import { HostPushCoalescer, type CoalescerClock } from "./host-push-coalescer.js";

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
});
