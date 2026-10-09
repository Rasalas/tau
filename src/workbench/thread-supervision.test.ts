import { describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import { ThreadStore, type ThreadActivitySnapshot } from "./thread-store";
import { threadAge, threadListDrafts, threadListGroups, threadListOrder, threadSupervisionRows, threadSupervisionStatus } from "./thread-supervision";

function thread(id: string, modifiedAt: number, title = id): UiSession {
  return { id, path: `/p/${id}`, title, modifiedAt, projectPath: "/p", projectName: "p", messageCount: 1 };
}

const idle: ThreadActivitySnapshot = {
  activeThreadId: "", isStreaming: false, unreadThreadIds: [], waitingThreadIds: [],
  runningThreadIds: [], failedThreadIds: [], interruptedThreadIds: [], limitedThreadIds: [], runningStartedAt: {},
};

describe("thread supervision", () => {
  it("displays a proxy's home runtime and machine without changing its selection address", () => {
    const machine = { id: "rex", name: "rex", backendKind: "codex", modelProvider: "openai" };
    const proxy = { ...thread("rex~t1", 1), backendKind: "machine", modelProvider: "anthropic", machine };
    expect(threadSupervisionRows([proxy], idle)[0]).toMatchObject({
      id: "rex~t1", path: proxy.path, backendKind: "codex", modelProvider: "openai", machine,
    });
    expect(threadListGroups([proxy], idle)[0].rows[0]).toMatchObject({ backendKind: "codex", modelProvider: "openai", machine });
  });

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

  it("shows kits' marks as on the desktop rail: one that asks sorts first, background work waits in place", () => {
    const marks = { a: { label: "Waiting", tone: "background" as const }, c: { label: "Your turn" } };
    const [active] = threadListGroups([thread("a", 50), thread("b", 40), thread("c", 10)], { ...idle, runningThreadIds: ["b"] }, { marks });
    expect(active!.rows.map((row) => [row.id, row.state.activity, row.state.label])).toEqual([
      ["c", "waiting", "Your turn"],
      ["b", "working", "Working"],
      ["a", "background", "Waiting"],
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

  it("gives the whole list's order, past every page", () => {
    const threads = Array.from({ length: 45 }, (_, index) => thread(`t${index}`, index));
    const order = threadListOrder(threads, idle, { pinned: ["t0"], settled: ["t44"] });
    expect(order).toHaveLength(45);
    expect(order.slice(0, 3)).toEqual(["t0", "t43", "t42"]);
    expect(order.at(-1)).toBe("t44");
  });

  it("lists no session nobody wrote in yet, unless it already runs", () => {
    const blank = { ...thread("blank", 9), messageCount: 0 };
    const ids = (activity: ThreadActivitySnapshot) => threadListGroups([thread("a", 1), blank], activity).flatMap((group) => group.rows.map((row) => row.id));
    expect(ids(idle)).toEqual(["a"]);
    expect(ids({ ...idle, runningThreadIds: ["blank"] })).toEqual(["blank", "a"]);
  });

  it("keeps one project's threads, named by its id or, from an older host, its path", () => {
    const threads = [{ ...thread("a", 3), workspaceId: "ws-a", projectPath: "/a" }, { ...thread("b", 2), projectPath: "/b" }, thread("c", 1)];
    const ids = (project: { path: string; workspaceId?: string }) => threadListGroups(threads, idle, { project }).flatMap((group) => group.rows.map((row) => row.id));
    expect(ids({ path: "/a", workspaceId: "ws-a" })).toEqual(["a"]);
    expect(ids({ path: "/b" })).toEqual(["b"]);
  });

  it("leaves a spawned thread with its parent unless it waits for the user", () => {
    const child = { ...thread("child", 9), parentThreadId: "a" };
    expect(threadListGroups([thread("a", 1), child], idle).flatMap((group) => group.rows.map((row) => row.id))).toEqual(["a"]);
    expect(threadListGroups([thread("a", 1), child], { ...idle, waitingThreadIds: ["child"] })[0].rows[0].id).toBe("child");
  });

  it("says how old a row is in a few characters", () => {
    const now = 10 * 86_400_000;
    expect(threadAge(now - 20_000, now)).toBe("now");
    expect(threadAge(now - 5 * 60_000, now)).toBe("5m");
    expect(threadAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(threadAge(now - 2 * 86_400_000, now)).toBe("2d");
    expect(threadAge(now - 21 * 86_400_000, now)).toBe("21d");
  });
});

describe("the compact list's drafts", () => {
  const draft = (draftId: string, projectPath: string, sessionId?: string) => ({
    draftId, projectName: projectPath.slice(1), projectPath, preview: "", attachments: 0, createdAt: 1, active: false, ...(sessionId ? { sessionId } : {}),
  });

  it("keeps the filtered project's drafts, and gives way to a thread the list shows", () => {
    const drafts = [draft("a", "/p"), draft("b", "/q"), draft("c", "/p", "fresh"), draft("d", "/p", "written")];
    const threads = [{ ...thread("fresh", 1), messageCount: 0 }, thread("written", 2)];
    expect(threadListDrafts(drafts, threads, idle).map((entry) => entry.draftId)).toEqual(["a", "b", "c"]);
    expect(threadListDrafts(drafts, threads, idle, { path: "/p" }).map((entry) => entry.draftId)).toEqual(["a", "c"]);
    // A session nobody wrote in shows once it runs; the draft gives way then.
    expect(threadListDrafts(drafts, threads, { ...idle, runningThreadIds: ["fresh"] }).map((entry) => entry.draftId)).toEqual(["a", "b"]);
  });
});
