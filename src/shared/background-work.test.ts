import { describe, expect, it } from "vitest";
import { backgroundCount, backgroundHoldsRun, backgroundSummary } from "./background-work.js";
import type { UiBackgroundTask } from "./contracts.js";

const task = (kind: UiBackgroundTask["kind"], label: string = kind): UiBackgroundTask => ({ id: label, kind, label });

describe("background work", () => {
  it("requires every task unless it is explicitly released", () => {
    expect(backgroundHoldsRun(undefined)).toBe(false);
    expect(backgroundHoldsRun([task("command")])).toBe(true);
    expect(backgroundHoldsRun([{ ...task("command"), blocksCompletion: false }])).toBe(false);
    expect(backgroundHoldsRun([{ ...task("command"), blocksCompletion: false }, task("task")])).toBe(true);
    expect(backgroundHoldsRun([task("command"), task("agent")])).toBe(true);
  });

  it("counts by kind, monitors first", () => {
    expect(backgroundCount([task("command", "a"), task("monitor", "b"), task("command", "c")])).toBe("1 monitor and 2 commands");
    expect(backgroundCount([task("agent"), task("task"), task("monitor")])).toBe("1 monitor, 1 sub-agent and 1 task");
  });

  it("says Waiting for sub-agents and tasks", () => {
    expect(backgroundSummary([task("agent", "Review")])).toEqual({ label: "Waiting", hint: "1 sub-agent in the background: Review. The agent continues when it reports." });
    expect(backgroundSummary([task("command", "npm test")]).label).toBe("Waiting");
    expect(backgroundSummary([{ ...task("command", "npm run dev"), blocksCompletion: false }])).toEqual({ label: "Running", hint: "1 command in the background: npm run dev. These services do not hold the request open." });
    expect(backgroundSummary([{ ...task("monitor"), state: "reported" }]).label).toBe("Waiting");
  });
});
