import { describe, expect, it } from "vitest";
import { TerminalActivity } from "./activity.js";

describe("unseen terminal output", () => {
  it("marks fresh output, acknowledges only the shells read, and ignores duplicate output", () => {
    const activity = new TerminalActivity();
    expect(activity.getSnapshot().size).toBe(0);
    activity.output("a", 20);
    activity.output("b", 30);
    activity.read(["a"]);
    expect([...activity.getSnapshot()]).toEqual(["b"]);
    activity.output("a", 20);
    activity.output("a", 10);
    expect([...activity.getSnapshot()]).toEqual(["b"]);
    activity.output("a", 21);
    expect(activity.getSnapshot().has("a")).toBe(true);
    activity.reset();
    expect(activity.getSnapshot().size).toBe(0);
  });
});
