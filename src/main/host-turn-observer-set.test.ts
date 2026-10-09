import { describe, expect, it } from "vitest";
import { HostTurnObserverSet } from "./host-extensions.js";

describe("HostTurnObserverSet runs", () => {
  it("counts accepted prompts until they end, but not a steer that joins one", async () => {
    const after: string[] = [];
    const set = new HostTurnObserverSet((sessionId) => after.push(sessionId));
    set.accepted("t1", "p1", { deferBefore: false });
    set.accepted("t1", "steer", { deferBefore: true, expectsInput: false });
    set.accepted("t1", "p2", { deferBefore: true });
    expect(set.hasOpenTurn("t1")).toBe(true);
    await set.ended("t1", "p1", "completed");
    expect(set.hasOpenTurn("t1")).toBe(true);
    await set.cancelled("t1", "p2");
    expect(set.hasOpenTurn("t1")).toBe(false);
    await set.cancelled("t1", "steer");
    expect(after).toEqual(["t1", "t1"]);
  });

  it("reports a run once, failed when any of its prompts failed", async () => {
    const set = new HostTurnObserverSet();
    const heard: string[] = [];
    set.add({ runEnded: (sessionId, outcome) => heard.push(`${sessionId}:${outcome}`) });
    set.runEnded("t1");
    await set.ended("t1", "p1", "failed");
    await set.ended("t1", "p2", "completed");
    set.runEnded("t1");
    set.runEnded("t1");
    expect(heard).toEqual(["t1:failed"]);
  });

  it("reports a run the runtime began itself, and lets a failed prompt of it win", async () => {
    const set = new HostTurnObserverSet();
    const heard: string[] = [];
    set.add({ runEnded: (sessionId, outcome) => heard.push(`${sessionId}:${outcome}`) });
    set.unpromptedEnded("t1", "completed");
    set.runEnded("t1");
    await set.ended("t2", "p1", "failed");
    set.unpromptedEnded("t2", "completed");
    set.runEnded("t2");
    expect(heard).toEqual(["t1:completed", "t2:failed"]);
  });

  it("forgets the prompts of a runtime that closes", async () => {
    const after: string[] = [];
    const set = new HostTurnObserverSet((sessionId) => after.push(sessionId));
    set.accepted("t1", "p1", { deferBefore: false });
    await set.closed("t1");
    expect(set.hasOpenTurn("t1")).toBe(false);
    expect(after).toEqual(["t1"]);
  });
});
