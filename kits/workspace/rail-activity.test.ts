import { describe, expect, it } from "vitest";
import { threadRowStatus, type ThreadActivitySnapshot } from "tau";
import { railActivity } from "./rail-activity.js";

const idle: ThreadActivitySnapshot = {
  activeThreadId: "parent", isStreaming: false, unreadThreadIds: [], waitingThreadIds: [],
  runningThreadIds: [], runningStartedAt: {}, failedThreadIds: [], interruptedThreadIds: [], limitedThreadIds: [],
};

describe("work inherited by a rail row", () => {
  it("keeps every ancestor working from the earliest live start without changing its runtime or unrelated rows", () => {
    const source = { ...idle, runningThreadIds: ["child", "grandchild"], runningStartedAt: { child: 200, grandchild: 100 } };
    const result = railActivity(source, [], { parents: { child: "parent", grandchild: "child" }, workingChildren: {} });
    expect(threadRowStatus("parent", result)).toEqual({ activity: "working", label: "Working", startedAt: 100 });
    expect(threadRowStatus("other", result)).toEqual({ activity: "idle", label: "Idle" });
    expect(result.isStreaming).toBe(false);
    expect(source.runningThreadIds).toEqual(["child", "grandchild"]);
    expect(source.runningStartedAt).toEqual({ child: 200, grandchild: 100 });
  });

  it("uses the index lineage before a kit publishes it and preserves a parent's question", () => {
    const source = { ...idle, runningThreadIds: ["child"], waitingThreadIds: ["parent"] };
    const threads = [{ id: "child", parentThreadId: "parent", title: "Child", path: "/child", modifiedAt: 1, projectName: "p", projectPath: "/p", messageCount: 1 }];
    const result = railActivity(source, threads, { parents: {}, workingChildren: {} });
    expect(result.runningThreadIds).toContain("parent");
    expect(threadRowStatus("parent", result)).toEqual({ activity: "waiting", label: "Question" });
  });

  it("includes work reported only by a remote child's kit and bounds malformed ancestry", () => {
    const result = railActivity(idle, [], { parents: { parent: "child", child: "parent" }, workingChildren: { parent: 1 } });
    expect(new Set(result.runningThreadIds)).toEqual(new Set(["parent", "child"]));
    expect(railActivity(idle, [], { parents: {}, workingChildren: {} }).runningThreadIds).toEqual([]);
  });
});
