import { describe, expect, it } from "vitest";
import type { ThreadActivitySnapshot } from "./thread-store";
import { threadRowStatus } from "./thread-row-status";

const idle: ThreadActivitySnapshot = {
  activeThreadId: "", isStreaming: false, unreadThreadIds: [], waitingThreadIds: [],
  runningThreadIds: [], failedThreadIds: [], interruptedThreadIds: [], limitedThreadIds: [], runningStartedAt: {},
};

describe("a thread row's state", () => {
  it("names a question Question and puts it before the run it stops", () => {
    const activity = { ...idle, waitingThreadIds: ["a"], runningThreadIds: ["a"], runningStartedAt: { a: 5 } };
    expect(threadRowStatus("a", activity)).toEqual({ activity: "waiting", label: "Question" });
  });

  it("times a run from the start the store holds", () => {
    const activity = { ...idle, runningThreadIds: ["a"], runningStartedAt: { a: 1_000 } };
    expect(threadRowStatus("a", activity)).toEqual({ activity: "working", label: "Working", startedAt: 1_000 });
  });

  it("gives a failed turn its reason, and a finished one Ready until it is read", () => {
    expect(threadRowStatus("a", { ...idle, failedThreadIds: ["a"] }, { turnError: "HTTP 500" })).toEqual({ activity: "failed", label: "Failed", hint: "HTTP 500" });
    expect(threadRowStatus("a", { ...idle, unreadThreadIds: ["a"] })).toEqual({ activity: "ready", label: "Ready" });
    expect(threadRowStatus("a", idle)).toEqual({ activity: "idle", label: "Idle" });
  });
});
