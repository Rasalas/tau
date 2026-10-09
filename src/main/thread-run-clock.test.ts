import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol.js";
import { ThreadRunClock } from "./thread-run-clock.js";

describe("ThreadRunClock", () => {
  it("stamps a run's start on every report of it and forgets it when the run ends", () => {
    let now = 1_000;
    const clock = new ThreadRunClock(() => now);
    expect(clock.stamp({ type: "agent-status", sessionId: "a", running: true })).toEqual({ type: "agent-status", sessionId: "a", running: true, startedAt: 1_000 });
    now = 80_000;
    // An automatic retry reports the run as started again; it is the same run.
    expect(clock.stamp({ type: "agent-status", sessionId: "a", running: true })).toMatchObject({ startedAt: 1_000 });
    expect(clock.runs()).toEqual({ a: 1_000 });
    expect(clock.stamp({ type: "agent-status", sessionId: "a", running: false })).toEqual({ type: "agent-status", sessionId: "a", running: false });
    expect(clock.runs()).toEqual({});
    expect(clock.stamp({ type: "agent-status", sessionId: "a", running: true })).toMatchObject({ startedAt: 80_000 });
  });

  it("passes every other event through untouched", () => {
    const clock = new ThreadRunClock(() => 5);
    const event = { type: "notice" as const, sessionId: "a", message: "hi", level: "info" as const };
    expect(clock.stamp(event)).toBe(event);
    expect(clock.runs()).toEqual({});
  });
});

describe("ThreadRunClock across turns", () => {
  const run = (event: "started" | "settled", sessionId = "a") => ({ type: "host-update" as const, update: { version: HOST_PROTOCOL_VERSION, type: "run" as const, event, sessionId } });
  const status = (running: boolean, sessionId = "a") => ({ type: "agent-status" as const, sessionId, running });

  function setup() {
    let continues = false;
    const forwarded: HostEvent[] = [];
    const ended: string[] = [];
    const clock = new ThreadRunClock(() => 1_000, {
      continues: () => continues,
      forward: (event) => forwarded.push(event),
      ended: (sessionId) => ended.push(sessionId),
    }, 10_000);
    return { clock, forwarded, ended, setContinues: (value: boolean) => { continues = value; } };
  }

  afterEach(() => { vi.useRealTimers(); });

  it("keeps a run going over the gap to the queued turn behind it", async () => {
    const { clock, forwarded, ended, setContinues } = setup();
    clock.stamp(run("started"));
    clock.stamp(status(true));
    setContinues(true);
    expect(clock.stamp(run("settled"))).toBeUndefined();
    expect(clock.stamp(status(false))).toBeUndefined();
    clock.stamp(run("started"));
    expect(clock.stamp(status(true))).toMatchObject({ startedAt: 1_000 });
    setContinues(false);
    expect(clock.stamp(run("settled"))).toEqual(run("settled"));
    expect(clock.stamp(status(false))).toEqual(status(false));
    await Promise.resolve();
    expect(forwarded).toEqual([]);
    expect(ended).toEqual(["a"]);
  });

  it("sends a held end once nothing continues the thread", async () => {
    const { clock, forwarded, ended, setContinues } = setup();
    clock.stamp(status(true));
    setContinues(true);
    clock.stamp(run("settled"));
    clock.stamp(status(false));
    clock.recheck("a");
    expect(forwarded).toEqual([]);
    setContinues(false);
    clock.recheck("a");
    expect(forwarded).toEqual([run("settled"), status(false)]);
    expect(clock.runs()).toEqual({});
    await Promise.resolve();
    expect(ended).toEqual(["a"]);
  });

  it("gives up waiting when the next turn never starts", () => {
    vi.useFakeTimers();
    const { clock, forwarded, setContinues } = setup();
    clock.stamp(status(true));
    setContinues(true);
    clock.stamp(run("settled"));
    clock.stamp(status(false));
    vi.advanceTimersByTime(10_000);
    expect(forwarded).toEqual([run("settled"), status(false)]);
  });

  it("reports a prompt that ended without a run as the end of one", () => {
    const { clock, ended } = setup();
    clock.recheck("a");
    expect(ended).toEqual(["a"]);
    clock.stamp(status(true));
    clock.recheck("a");
    expect(ended).toEqual(["a"]);
  });
});
