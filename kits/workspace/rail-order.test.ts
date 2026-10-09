import { describe, expect, it } from "vitest";
import type { UiProject, UiSession } from "tau";
import { groupThreads, readRailOrder, sortThreads } from "./rail-order.js";

const thread = (id: string, patch: Partial<UiSession> = {}): UiSession => ({
  id, path: `/s/${id}.jsonl`, title: id, modifiedAt: 0, projectPath: "/repo", projectName: "repo", messageCount: 1, ...patch,
});

function preferences(values: Record<string, string>, options: Record<string, boolean> = {}) {
  return {
    value: (_id: string, key: string) => values[key],
    optionValue: (_id: string, key: string, fallback: boolean) => options[key] ?? fallback,
  };
}

describe("readRailOrder", () => {
  it("falls back to the defaults, and to repository grouping for the old toggle", () => {
    expect(readRailOrder(preferences({}))).toEqual({ grouping: "none", projectSort: "activity", preview: 6 });
    expect(readRailOrder(preferences({}, { "group-by-project": true })).grouping).toBe("repository");
    expect(readRailOrder(preferences({ "rail-grouping": "separate" }, { "group-by-project": true })).grouping).toBe("separate");
  });

  it("ignores values it does not know", () => {
    expect(readRailOrder(preferences({ "rail-grouping": "tree", "rail-preview": "99", "rail-thread-sort": "size" }))).toEqual({ grouping: "none", projectSort: "activity", preview: 6 });
    expect(readRailOrder(preferences({ "rail-preview": "3" })).preview).toBe(3);
  });
});

describe("sortThreads", () => {
  it("sorts by creation, newest first, whatever ran last", () => {
    const threads = [thread("old", { modifiedAt: 30, createdAt: 1 }), thread("new", { modifiedAt: 10, createdAt: 20 }), thread("unknown", { modifiedAt: 5 })];
    expect(sortThreads(threads).map((entry) => entry.id)).toEqual(["new", "unknown", "old"]);
  });

  it("keeps a row in place when its thread runs a turn", () => {
    const before = [thread("a", { modifiedAt: 10, createdAt: 3 }), thread("b", { modifiedAt: 20, createdAt: 2 }), thread("c", { modifiedAt: 30, createdAt: 1 })];
    const after = before.map((entry) => entry.id === "c" ? { ...entry, modifiedAt: 99 } : entry);
    expect(sortThreads(after).map((entry) => entry.id)).toEqual(sortThreads(before).map((entry) => entry.id));
  });
});

describe("groupThreads", () => {
  const projects: UiProject[] = [
    { path: "/repo", name: "repo", lastOpenedAt: 1 },
    { path: "/repo/web", name: "repo", lastOpenedAt: 5 },
    { path: "/zeta", name: "zeta", lastOpenedAt: 3 },
  ];
  const projectOf = (session: UiSession) => projects.find((project) => project.path === session.projectPath)
    ?? projects.find((project) => project.name === session.projectName);
  const threads = [
    thread("worktree", { projectPath: "/worktrees/repo/fix-rail", projectName: "repo", workspaceId: "wt" }),
    thread("zeta", { projectPath: "/zeta", projectName: "zeta" }),
    thread("web", { projectPath: "/repo/web", projectName: "repo" }),
    thread("root", { projectPath: "/repo", projectName: "repo" }),
  ];
  const shape = (groups: ReturnType<typeof groupThreads>) => groups.map((group) => [group.label, group.threads.map((entry) => entry.id)]);

  it("puts a repository's worktrees and folders in one group by repository", () => {
    expect(shape(groupThreads(threads, "repository", "activity", projectOf))).toEqual([["repo", ["worktree", "web", "root"]], ["zeta", ["zeta"]]]);
  });

  it("keeps a repository's project folders apart by repository path", () => {
    expect(shape(groupThreads(threads, "repository_path", "activity", projectOf))).toEqual([
      ["repo", ["worktree", "root"]],
      ["zeta", ["zeta"]],
      ["repo · web", ["web"]],
    ]);
  });

  it("gives every checkout its own group", () => {
    expect(shape(groupThreads(threads, "separate", "activity", projectOf)).map(([label]) => label)).toEqual(["repo · fix-rail", "zeta", "repo · web", "repo"]);
  });

  it("orders groups by name or by when the project was last opened", () => {
    expect(shape(groupThreads(threads, "repository_path", "name", projectOf)).map(([label]) => label)).toEqual(["repo", "repo · web", "zeta"]);
    expect(shape(groupThreads(threads, "repository_path", "opened", projectOf)).map(([label]) => label)).toEqual(["repo · web", "zeta", "repo"]);
  });

  it("orders groups by their newest thread, not by the latest turn", () => {
    const sorted = sortThreads([
      thread("fresh-old-repo", { projectName: "old", modifiedAt: 50, createdAt: 1 }),
      thread("new-repo", { projectName: "new", modifiedAt: 10, createdAt: 40 }),
    ]);
    expect(groupThreads(sorted, "repository", "activity", () => undefined).map((group) => group.label)).toEqual(["new", "old"]);
  });
});
