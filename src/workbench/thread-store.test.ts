import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadStore } from "./thread-store";

const shell = (id: string, title = id) => ({
  id, path: `/tmp/${id}.jsonl`, title, modifiedAt: 1,
  projectPath: "/tmp/project", projectName: "project", messageCount: 1,
});

afterEach(() => vi.useRealTimers());

describe("ThreadStore selective navigation subscriptions", () => {
  it("keeps ids and unchanged shell references stable", () => {
    const store = new ThreadStore();
    const first = [shell("one"), shell("two")];
    store.applyThreadIndex({ projects: [{ path: "/tmp/project", name: "project", lastOpenedAt: 1 }], sessions: first });
    const ids = store.getThreadIds();
    const projects = store.getProjects();
    store.applyThreadIndex({ projects: [{ path: "/tmp/project", name: "project", lastOpenedAt: 1 }], sessions: [shell("one", "renamed"), shell("two")] });
    expect(store.getThreadIds()).toBe(ids);
    expect(store.getProjects()).toBe(projects);
    expect(store.getThread("two")).toBe(first[1]);
  });

  it("notifies only the changed shell listener", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")] });
    let one = 0;
    let two = 0;
    store.subscribeToThread("one", () => { one += 1; });
    store.subscribeToThread("two", () => { two += 1; });
    store.applyThreadIndex({ projects: [], sessions: [shell("one", "updated"), shell("two")] });
    expect(one).toBe(1);
    expect(two).toBe(0);
  });

  it("does not invalidate project, id, or activity subscribers for one shell change", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [{ path: "/tmp/project", name: "project", lastOpenedAt: 1 }], sessions: [shell("one"), shell("two")] });
    let ids = 0;
    let projects = 0;
    let activity = 0;
    store.subscribeToIds(() => { ids += 1; });
    store.subscribeToProjects(() => { projects += 1; });
    store.subscribeToActivity(() => { activity += 1; });
    store.applyThreadShell("one", shell("one", "renamed"));
    expect({ ids, projects, activity }).toEqual({ ids: 0, projects: 0, activity: 0 });
  });

  it("applies one incremental shell without replacing the index", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")] });
    const two = store.getThread("two");
    store.applyThreadShell("one", shell("one", "incremental"));
    expect(store.getThread("one")?.title).toBe("incremental");
    expect(store.getThread("two")).toBe(two);
    store.applyThreadShell("one", undefined, true);
    expect(store.getThreadIds()).toEqual(["two"]);
  });

  it("takes a shell whose only change is what the thread cost, as a price change makes it", () => {
    const store = new ThreadStore();
    const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11, costUsd: 0.01, turns: 1 };
    store.applyThreadIndex({ projects: [], sessions: [{ ...shell("one"), usage }] });
    const repriced = { ...usage, costUsd: 0, subscription: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11, turns: 1, apiValueUsd: 0.01 } };
    store.applyThreadShell("one", { ...shell("one"), usage: repriced });
    expect(store.getThread("one")?.usage).toEqual(repriced);
  });

  it("keeps an observed provider when a later index shell omits it", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")] });
    store.setThreadModelProvider("two", "openai-codex");
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")] });
    expect(store.getThread("two")?.modelProvider).toBe("openai-codex");
  });

  it("updates a thread's observed model provider without replacing other shells", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")] });
    const two = store.getThread("two");
    store.setThreadModelProvider("one", "google");
    expect(store.getThread("one")?.modelProvider).toBe("google");
    expect(store.getThread("two")).toBe(two);
  });

  it("records a stable start time for each running thread", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    const store = new ThreadStore();
    store.setThreadRunning("one", true);
    const startedAt = store.getActivity().runningStartedAt.one;
    vi.advanceTimersByTime(5_000);
    store.setThreadRunning("one", true);
    expect(store.getActivity().runningStartedAt.one).toBe(startedAt);
    store.setThreadRunning("one", false);
    expect(store.getActivity().runningStartedAt.one).toBeUndefined();
  });
});

describe("ThreadStore interrupted threads", () => {
  it("mirrors the index's interrupted mark and clears it when the index does", () => {
    const store = new ThreadStore();
    let activity = 0;
    store.subscribeToActivity(() => { activity += 1; });

    store.applyThreadIndex({ projects: [], sessions: [{ ...shell("one"), interrupted: true }, shell("two")] });
    expect(store.getActivity().interruptedThreadIds).toEqual(["one"]);
    expect(activity).toBe(1);

    store.applyThreadShell("one", shell("one"));
    expect(store.getActivity().interruptedThreadIds).toEqual([]);
  });

  it("keeps the same list across a rescan that changes nothing", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [{ ...shell("one"), interrupted: true }] });
    const list = store.getActivity().interruptedThreadIds;
    store.applyThreadIndex({ projects: [], sessions: [{ ...shell("one"), interrupted: true }] });
    expect(store.getActivity().interruptedThreadIds).toBe(list);
  });
});
