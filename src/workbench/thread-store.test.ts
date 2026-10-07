import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadStore } from "./thread-store";

const shell = (id: string, title = id) => ({
  id, path: `/tmp/${id}.jsonl`, title, modifiedAt: 1,
  projectPath: "/tmp/project", projectName: "project", messageCount: 1,
});

afterEach(() => vi.useRealTimers());

describe("ThreadStore selective navigation subscriptions", () => {
  it("keeps live run state through navigation and stale snapshot hints in both directions", () => {
    const store = new ThreadStore();
    store.setThreadRunning("one", true, 1_000);
    store.setActiveThread("two");
    store.setActiveThread("one", false);
    expect(store.getActivity().isStreaming).toBe(true);
    expect(store.getActivity().runningStartedAt.one).toBe(1_000);
    store.setThreadRunning("one", false);
    store.setActiveThread("one", true);
    expect(store.getActivity().isStreaming).toBe(false);
  });

  it("uses bootstrap runs over stale details after reconnecting", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")], runs: { one: 1_000 } });
    store.setActiveThread("one", false);
    expect(store.getActivity().runningStartedAt.one).toBe(1_000);
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")], runs: {} });
    store.setActiveThread("one", true);
    expect(store.getActivity().isStreaming).toBe(false);
  });
  it("keeps a nonempty thread visible when an older full index reports zero messages", () => {
    const store = new ThreadStore();
    store.applyThreadShell("one", shell("one"));
    store.applyThreadIndex({ projects: [], sessions: [{ ...shell("one"), messageCount: 0 }] });
    expect(store.getThread("one")?.messageCount).toBe(1);
  });
  it("publishes a proxy workspace identity revision even when its host path is unchanged", () => {
    const store = new ThreadStore();
    const proxy = { ...shell("rex~one"), backendKind: "machine", workspaceId: "ws1_before", projectDisplayPath: "/home/dev/repo" };
    store.applyThreadIndex({ projects: [], sessions: [proxy] });
    const changed = vi.fn();
    store.subscribeToThread(proxy.id, changed);
    const next = { ...proxy, workspaceId: "ws1_original", projectDisplayPath: "~/repo" };
    store.applyThreadIndex({ projects: [], sessions: [next] });
    expect(store.getThread(proxy.id)).toBe(next);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("refreshes a proxy's machine marks without invalidating unrelated rows", () => {
    const store = new ThreadStore();
    const proxy = { ...shell("rex~one"), backendKind: "machine", machine: { id: "rex", name: "rex", backendKind: "pi" } };
    store.applyThreadIndex({ projects: [], sessions: [proxy, shell("two")] });
    const changed = vi.fn();
    const unrelated = vi.fn();
    store.subscribeToThread(proxy.id, changed);
    store.subscribeToThread("two", unrelated);
    const renamed = { ...proxy, machine: { ...proxy.machine, name: "Rex", backendKind: "codex", modelProvider: "openai" } };
    store.applyThreadIndex({ projects: [], sessions: [renamed, shell("two")] });
    expect(store.getThread(proxy.id)).toBe(renamed);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    store.applyThreadIndex({ projects: [], sessions: [{ ...renamed, machine: { ...renamed.machine } }, shell("two")] });
    expect(changed).toHaveBeenCalledTimes(1);
  });

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

  it("compares a fresh copy of a shell's records by value, and sees a field added, removed or changed", () => {
    const store = new ThreadStore();
    const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11, costUsd: 0.01, turns: 1 };
    const queued = [{ id: "q1", text: "next", attachments: 0 }];
    const limit = { kind: "rate-limit", resetsAt: 5 };
    const full = (extra: Record<string, unknown> = {}) => ({ ...shell("one"), usage: { ...usage }, queued: queued.map((item) => ({ ...item })), limit: { ...limit }, ...extra }) as never;
    store.applyThreadIndex({ projects: [], sessions: [full()] });
    const kept = store.getThread("one");
    store.applyThreadShell("one", full());
    expect(store.getThread("one")).toBe(kept);
    for (const changed of [
      { usage: { ...usage, costUsd: 0.02 } },
      { usage: { ...usage, subscription: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11, turns: 1, apiValueUsd: 0.01 } } },
      { usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11, costUsd: 0.01 } },
      { usage: undefined },
      { queued: [...queued, { id: "q2", text: "then", attachments: 1 }] },
      { limit: { ...limit, resetsAt: 6 } },
    ]) {
      store.applyThreadIndex({ projects: [], sessions: [full()] });
      const before = store.getThread("one");
      store.applyThreadShell("one", full(changed));
      expect(store.getThread("one")).not.toBe(before);
    }
  });

  it("keeps an observed provider when a later index shell omits it", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")] });
    store.setThreadModelProvider("two", "openai-codex");
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two")] });
    expect(store.getThread("two")?.modelProvider).toBe("openai-codex");
  });

  it("takes a model change within one provider, and keeps the model when a later index shell omits it", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one")] });
    store.setThreadModelProvider("one", "openai-codex", "gpt-5.6-luna");
    store.setThreadModelProvider("one", "openai-codex", "gpt-5.6-sol");
    expect(store.getThread("one")).toMatchObject({ modelProvider: "openai-codex", model: "gpt-5.6-sol" });
    store.applyThreadIndex({ projects: [], sessions: [shell("one")] });
    expect(store.getThread("one")?.model).toBe("gpt-5.6-sol");
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

  it("times a run from the host's start, over its own clock", () => {
    const store = new ThreadStore();
    store.setThreadRunning("one", true);
    store.setThreadRunning("one", true, 1_000);
    expect(store.getActivity().runningStartedAt.one).toBe(1_000);
    // Started again, as after an automatic retry: the run keeps its first start.
    store.setThreadRunning("one", true);
    expect(store.getActivity().runningStartedAt.one).toBe(1_000);
  });

  it("takes a bootstrap's runs over what it knew, and keeps its runs through an index without them", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two"), shell("three")] });
    store.setThreadRunning("one", true);
    store.markFailed("two");
    // Away for a while: "one" ended, "two" started again, and this client heard of neither.
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two"), shell("three")], runs: { two: 5_000 } });
    expect(store.getActivity().runningThreadIds).toEqual(["two"]);
    expect(store.getActivity().runningStartedAt).toEqual({ two: 5_000 });
    expect(store.getActivity().failedThreadIds).toEqual([]);
    const activity = store.getActivity();
    store.applyThreadIndex({ projects: [], sessions: [shell("one"), shell("two", "renamed"), shell("three")] });
    expect(store.getActivity()).toBe(activity);
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

describe("a new thread's message count", () => {
  it("counts the prompt of a run the host's shell has not counted yet, and never goes back to 0", () => {
    const store = new ThreadStore();
    const created = { id: "created", path: "/created.jsonl", title: "", modifiedAt: 1, projectPath: "/p", projectName: "p", messageCount: 0 };
    store.applyThreadShell("created", created);
    store.setThreadRunning("created", true);
    expect(store.getThread("created")?.messageCount).toBe(1);
    // A shell read before the prompt was written arrives late; the run ends before the counted one.
    store.applyThreadShell("created", { ...created, title: "Count slowly" });
    store.setThreadRunning("created", false);
    expect(store.getThread("created")).toMatchObject({ title: "Count slowly", messageCount: 1 });
    store.applyThreadShell("created", { ...created, messageCount: 2 });
    expect(store.getThread("created")?.messageCount).toBe(2);
    // A session nobody ran stays at 0.
    store.applyThreadShell("blank", { ...created, id: "blank" });
    expect(store.getThread("blank")?.messageCount).toBe(0);
  });
});
