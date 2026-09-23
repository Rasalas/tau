import { describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import { ThreadStore, type ThreadActivitySnapshot } from "./thread-store";
import { threadSupervisionRows, threadSupervisionStatus } from "./thread-supervision";

function thread(id: string, modifiedAt: number, title = id): UiSession {
  return { id, path: `/p/${id}`, title, modifiedAt, projectPath: "/p", projectName: "p", messageCount: 1 };
}

const idle: ThreadActivitySnapshot = {
  activeThreadId: "", isStreaming: false, unreadThreadIds: [], waitingThreadIds: [],
  runningThreadIds: [], failedThreadIds: [], interruptedThreadIds: [], runningStartedAt: {},
};

describe("thread supervision", () => {
  it("puts what needs an answer first, then what is running, then the rest by recency", () => {
    const activity: ThreadActivitySnapshot = {
      ...idle,
      waitingThreadIds: ["c"],
      runningThreadIds: ["b"],
      failedThreadIds: ["d"],
      runningStartedAt: { b: 1_000 },
    };
    const rows = threadSupervisionRows([thread("a", 30), thread("b", 20), thread("c", 10), thread("d", 40)], activity);
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["c", "waiting"], ["b", "running"], ["d", "failed"], ["a", "done"],
    ]);
    expect(rows[1].startedAt).toBe(1_000);
  });

  it("keeps the list a screen tall", () => {
    const threads = Array.from({ length: 30 }, (_, index) => thread(`t${index}`, index));
    expect(threadSupervisionRows(threads, idle, 5)).toHaveLength(5);
  });

  it("reports a refused delivery until the thread runs again", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [thread("a", 1)] });
    store.markFailed("a");
    expect(threadSupervisionStatus("a", store.getActivity())).toBe("failed");
    store.setThreadRunning("a", true);
    expect(threadSupervisionStatus("a", store.getActivity())).toBe("running");
    store.setThreadRunning("a", false);
    expect(threadSupervisionStatus("a", store.getActivity())).toBe("done");
  });

  it("reports a failed turn for as long as the index carries its error", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [{ ...thread("a", 1), turnError: "stream disconnected" }, thread("b", 2)] });
    expect(store.getActivity().failedThreadIds).toEqual(["a"]);
    store.markFailed("b");
    expect(store.getActivity().failedThreadIds).toEqual(["b", "a"]);
    store.applyThreadIndex({ projects: [], sessions: [thread("a", 1), thread("b", 2)] });
    expect(store.getActivity().failedThreadIds).toEqual(["b"]);
  });
});
