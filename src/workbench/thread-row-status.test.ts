import { describe, expect, it } from "vitest";
import type { ThreadActivitySnapshot } from "./thread-store";
import { attentionMarkIds, markedRowStatus, threadRowStatus } from "./thread-row-status";

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

describe("a row whose runtime works in the background", () => {
  const monitor = { id: "b1", kind: "monitor" as const, label: "Nightly run" };
  const server = { id: "b2", kind: "command" as const, label: "npm run dev" };

  it("says Monitoring in place of Ready, and Running for commands alone", () => {
    expect(threadRowStatus("a", { ...idle, unreadThreadIds: ["a"] }, { background: [monitor, server] })).toEqual({
      activity: "background", label: "Monitoring",
      hint: "1 monitor and 1 command in the background: Nightly run, npm run dev. The agent continues when it reports.",
    });
    expect(threadRowStatus("a", idle, { background: [server] })).toMatchObject({ activity: "background", label: "Running" });
  });

  it("leaves Working and a failure in front", () => {
    expect(threadRowStatus("a", { ...idle, runningThreadIds: ["a"], runningStartedAt: { a: 1 } }, { background: [monitor] })).toMatchObject({ activity: "working" });
    expect(threadRowStatus("a", { ...idle, failedThreadIds: ["a"] }, { background: [monitor] })).toMatchObject({ activity: "failed" });
  });
});

describe("a kit's mark on a row", () => {
  const yourTurn = { label: "Your turn" };
  const watching = { label: "Waiting", hint: "Watching #76", tone: "background" as const };

  it("draws a mark that asks as a question", () => {
    expect(markedRowStatus({ activity: "working", label: "Working" }, yourTurn)).toMatchObject({ activity: "waiting", label: "Your turn" });
  });

  it("puts background work in place of an idle or a ready row", () => {
    expect(markedRowStatus({ activity: "idle", label: "Idle" }, watching)).toMatchObject({ activity: "background", label: "Waiting", hint: "Watching #76" });
    expect(markedRowStatus({ activity: "ready", label: "Ready" }, watching)).toMatchObject({ activity: "background" });
  });

  it("lets a running, asking or failed thread say so over background work", () => {
    for (const activity of ["working", "waiting", "failed"] as const) {
      expect(markedRowStatus({ activity, label: "x" }, watching).activity).toBe(activity);
    }
  });

  it("counts only marks that ask for the user", () => {
    expect(attentionMarkIds({ a: yourTurn, b: watching })).toEqual(["a"]);
  });
});
