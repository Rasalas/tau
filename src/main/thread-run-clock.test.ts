import { describe, expect, it } from "vitest";
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
