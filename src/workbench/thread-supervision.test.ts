import { describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import { ThreadStore, type ThreadActivitySnapshot } from "./thread-store";
import { threadAge, threadElapsed, threadListGroups, threadSupervisionRows, threadSupervisionStatus } from "./thread-supervision";

function thread(id: string, modifiedAt: number, title = id): UiSession {
  return { id, path: `/p/${id}`, title, modifiedAt, projectPath: "/p", projectName: "p", messageCount: 1 };
}

const idle: ThreadActivitySnapshot = {
  activeThreadId: "", isStreaming: false, unreadThreadIds: [], waitingThreadIds: [],
  runningThreadIds: [], failedThreadIds: [], interruptedThreadIds: [], limitedThreadIds: [], runningStartedAt: {},
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

describe("the compact thread list", () => {
  it("groups pinned, active and settled threads, and ranks by need inside a group", () => {
    const activity: ThreadActivitySnapshot = { ...idle, runningThreadIds: ["b"], waitingThreadIds: ["d"] };
    const groups = threadListGroups(
      [thread("a", 50), thread("b", 10), thread("c", 40), thread("d", 5), thread("e", 30)],
      activity,
      { pinned: ["c", "b"], settled: ["e", "d"] },
    );
    expect(groups.map((group) => [group.id, group.rows.map((row) => row.id)])).toEqual([
      ["pinned", ["b", "c"]],
      // `d` is settled, but it asks the user something, so it is active again.
      ["active", ["d", "a"]],
      ["settled", ["e"]],
    ]);
  });

  it("pages the long groups and filters by title, project or label", () => {
    const threads = Array.from({ length: 15 }, (_, index) => thread(`t${index}`, index, index === 3 ? "Fix the Flaky test" : `Thread ${index}`));
    const settled = threads.map((entry) => entry.id);
    const [shelf] = threadListGroups(threads, idle, { settled });
    expect(shelf.rows).toHaveLength(10);
    expect(shelf.hidden).toBe(5);
    expect(threadListGroups(threads, idle, { settled, shown: { settled: 20 } })[0].hidden).toBe(0);
    expect(threadListGroups(threads, idle, { query: "flaky" }).flatMap((group) => group.rows.map((row) => row.id))).toEqual(["t3"]);
  });

  it("leaves a spawned thread with its parent unless it waits for the user", () => {
    const child = { ...thread("child", 9), parentThreadId: "a" };
    expect(threadListGroups([thread("a", 1), child], idle).flatMap((group) => group.rows.map((row) => row.id))).toEqual(["a"]);
    expect(threadListGroups([thread("a", 1), child], { ...idle, waitingThreadIds: ["child"] })[0].rows[0].id).toBe("child");
  });

  it("says how old a row is in a few characters", () => {
    const now = 10 * 86_400_000;
    expect(threadAge(now - 20_000, now)).toBe("<1m");
    expect(threadAge(now - 5 * 60_000, now)).toBe("5m");
    expect(threadAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(threadAge(now - 2 * 86_400_000, now)).toBe("2d");
    expect(threadAge(now - 21 * 86_400_000, now)).toBe("3w");
    expect(threadElapsed(0, 42_000)).toBe("42s");
    expect(threadElapsed(0, 185_000)).toBe("3m 05s");
  });
});
