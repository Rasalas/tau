import { describe, expect, it } from "vitest";
import { ThreadStore } from "./thread-store";

const shell = (id: string, title = id) => ({
  id, path: `/tmp/${id}.jsonl`, title, modifiedAt: 1,
  projectPath: "/tmp/project", projectName: "project", messageCount: 1,
});

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
});
