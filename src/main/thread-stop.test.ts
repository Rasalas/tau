import { describe, expect, it, vi } from "vitest";
import type { UiThreadGoal } from "../shared/contracts.js";
import { HostTurnObserverSet } from "./host-extensions.js";
import type { ThreadGoalCapability } from "./runtime-types.js";
import { controlGoal, stopLine, stopThread, type ThreadStopPort } from "./thread-stop.js";

function goals(goal: UiThreadGoal | undefined, pause: () => Promise<void> = async () => undefined): ThreadGoalCapability & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    current: () => goal,
    set: async (objective) => { calls.push(`set:${objective}`); },
    pause: async () => { calls.push("pause"); await pause(); },
    resume: async () => { calls.push("resume"); },
    clear: async () => { calls.push("clear"); },
  };
}

const active = (pause = true): UiThreadGoal => ({ objective: "Make CI green", status: "active", actions: { pause, resume: true }, updatedAt: 1 });

function port(overrides: Partial<ThreadStopPort> = {}, order: string[] = []): ThreadStopPort & { lines: string[]; toasts: string[] } {
  const lines: string[] = [];
  const toasts: string[] = [];
  let wakes = 2;
  return {
    lines,
    toasts,
    dropWakes: () => { order.push("dropWakes"); const dropped = wakes; wakes = 0; return dropped; },
    holdQueue: () => { order.push("hold"); },
    observers: async () => { order.push("observers"); return { stopped: ["stopped watching PR #42"], continues: [] }; },
    abort: async () => { order.push("abort"); },
    notice: async (text) => { lines.push(text); },
    toast: (text) => { toasts.push(text); },
    log: () => undefined,
    ...overrides,
  };
}

describe("stopLine", () => {
  it("says nothing when Stop only ended a turn", () => {
    expect(stopLine(undefined, { stopped: [], continues: [] }, 0)).toBeUndefined();
  });

  it("names what stopped and promises quiet only when nothing goes on", () => {
    expect(stopLine({ stopped: "goal paused" }, { stopped: ["stopped watching PR #42"], continues: [] }, 1))
      .toBe("Stopped · goal paused · stopped watching PR #42 · dropped a waiting wake. Nothing wakes this thread until you start it again.");
  });

  it("never claims quiet while a kit's work or the goal goes on", () => {
    expect(stopLine(undefined, { stopped: [], continues: ["2 sub-agents keep running and report back"] }, 0))
      .toBe("Stopped. 2 sub-agents keep running and report back.");
    expect(stopLine({ continues: "The goal stays set and goes on with your next message" }, { stopped: [], continues: [] }, 3))
      .toBe("Stopped · dropped 3 waiting wakes. The goal stays set and goes on with your next message.");
  });
});

describe("stopThread", () => {
  it("drops wakes before anything awaits, pauses the goal before the run stops, and writes one line", async () => {
    const order: string[] = [];
    const goal = goals(active(), async () => { order.push("paused"); });
    const stop = port({}, order);
    const line = await stopThread(goal, stop);
    expect(order.slice(0, 3)).toEqual(["dropWakes", "hold", "observers"]);
    expect(order.indexOf("paused")).toBeLessThan(order.indexOf("abort"));
    expect(line).toBe("Stopped · goal paused · stopped watching PR #42 · dropped 2 waiting wakes. Nothing wakes this thread until you start it again.");
    expect(stop.lines).toEqual([line]);
  });

  it("drops a wake a kit queued while it answered the stop", async () => {
    let calls = 0;
    const stop = port({ dropWakes: () => (calls += 1) === 1 ? 0 : 1, observers: async () => ({ stopped: [], continues: [] }) });
    expect(await stopThread(undefined, stop)).toBe("Stopped · dropped a waiting wake. Nothing wakes this thread until you start it again.");
    expect(calls).toBe(2);
  });

  it("says which background work keeps running after the stop", async () => {
    const stop = port({ background: () => [{ id: "b1", kind: "command", label: "npm run dev" }] });
    await stopThread(undefined, stop);
    expect(stop.lines).toEqual(["Stopped · stopped watching PR #42 · dropped 2 waiting wakes. 1 command keeps running in the background (npm run dev); stop it above the composer."]);
  });

  it("does not pretend a runtime without pause paused its goal", async () => {
    const goal = goals(active(false));
    const line = await stopThread(goal, port({ dropWakes: () => 0, observers: async () => ({ stopped: [], continues: [] }) }));
    expect(goal.calls).toEqual([]);
    expect(line).toBe("Stopped. The goal stays set and goes on with your next message.");
  });

  it("says so when the runtime refuses to pause, and still stops the run", async () => {
    const order: string[] = [];
    const goal = goals(active(), async () => { throw new Error("gone"); });
    const line = await stopThread(goal, port({ dropWakes: () => 0, observers: async () => ({ stopped: [], continues: [] }) }, order));
    expect(order).toContain("abort");
    expect(line).toBe("Stopped. The runtime did not confirm the goal paused; it may start another turn.");
  });

  it("falls back to a passing notice where the runtime has no transcript row", async () => {
    const stop = port({ notice: async () => { throw new Error("no row"); } });
    await stopThread(undefined, stop);
    expect(stop.toasts).toHaveLength(1);
  });
});

describe("controlGoal", () => {
  it("sends the objective, or the runtime's own command, as the goal's first turn", async () => {
    const prompts: string[] = [];
    const publish = vi.fn();
    const goal = goals(undefined);
    await controlGoal(goal, "set", "  Make CI green ", { prompt: async (text) => { prompts.push(text); }, publish });
    expect(goal.calls).toEqual(["set:Make CI green"]);
    expect(prompts).toEqual(["Make CI green"]);
    const claude = { ...goals(undefined), set: async (objective: string) => ({ prompt: `/goal ${objective}` }) };
    await controlGoal(claude, "set", "Ship it", { prompt: async (text) => { prompts.push(text); }, publish });
    expect(prompts.at(-1)).toBe("/goal Ship it");
    await expect(controlGoal(goal, "set", "  ", { prompt: async () => undefined, publish })).rejects.toThrow(/Name the goal/u);
  });

  it("ends a goal through dismiss where the runtime has one, else through clear", async () => {
    const goal = goals(active());
    await controlGoal(goal, "dismiss", undefined, { prompt: async () => undefined, publish: () => undefined });
    expect(goal.calls).toEqual(["clear"]);
  });
});

describe("HostTurnObserverSet.stopped", () => {
  it("joins phrases and reports, and leaves out an observer that fails or hangs", async () => {
    const set = new HostTurnObserverSet();
    set.add({ stopped: () => ["stopped watching PR #42"] });
    set.add({ stopped: async () => ({ stopped: ["ended the secret request"], continues: ["a sub-agent keeps running"] }) });
    set.add({ stopped: () => { throw new Error("broken"); } });
    set.add({ stopped: () => new Promise<never>(() => undefined) });
    set.add({ ended: async () => undefined });
    expect(await set.stopped("t", 20)).toEqual({
      stopped: ["stopped watching PR #42", "ended the secret request"],
      continues: ["a sub-agent keeps running"],
    });
  });
});
