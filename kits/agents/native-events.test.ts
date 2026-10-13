import { expect, it } from "vitest";
import { NativeAgentTracker } from "./native-events.js";

it("records one return per child run and retains earlier returns when resumed", () => {
  let now = 100;
  const tracker = new NativeAgentTracker("codex", () => now);
  const lastTool = (events: ReturnType<NativeAgentTracker["update"]>) => {
    const event = events.at(-1)!;
    if (event.type !== "tool-end") throw new Error("Expected a child update");
    return event.tool;
  };
  tracker.update("child", { title: "Review" });
  now = 200;
  const done = lastTool(tracker.update("child", { status: "idle" }));
  expect(done.args.reports).toEqual([{ id: "1", timestamp: 200, status: "completed" }]);
  expect(lastTool(tracker.update("child", { status: "completed" })).args.reports).toEqual(done.args.reports);
  expect(lastTool(tracker.text("child", "result", "OK")).args.reports).toEqual(done.args.reports);
  now = 300;
  tracker.update("child", { status: "running" });
  now = 400;
  const failed = lastTool(tracker.update("child", { status: "failed" }));
  expect(failed.startedAt).toBe(100);
  expect(failed.args.reports).toEqual([
    { id: "1", timestamp: 200, status: "completed" },
    { id: "2", timestamp: 400, status: "failed" },
  ]);
  expect(lastTool(tracker.update("child", { status: "idle" })).args.reports).toEqual(failed.args.reports);
});
