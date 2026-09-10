import { describe, expect, it } from "vitest";
import type { UiSession } from "tau";
import { findProjectForSession, navigationRowKey, visibleThreads } from "./navigation.js";

function session(id: string): UiSession {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    title: id,
    modifiedAt: 1,
    projectPath: "/project",
    projectName: "project",
    messageCount: 1,
  };
}

describe("thread navigation virtualization", () => {
  it("keys measured rows by thread identity rather than their sorted index", () => {
    const first = [
      { kind: "thread" as const, id: "one", session: session("one"), depth: 0 },
      { kind: "thread" as const, id: "two", session: session("two"), depth: 0 },
    ];
    const reordered = [first[1], first[0]];

    expect(navigationRowKey(first, 0)).toBe("one");
    expect(navigationRowKey(reordered, 0)).toBe("two");
    expect(new Set(reordered.map((_, index) => navigationRowKey(reordered, index)))).toEqual(new Set(["one", "two"]));
  });
});

function spawned(id: string, parentThreadId?: string): UiSession {
  return parentThreadId ? { ...session(id), parentThreadId } : session(id);
}

describe("threads an agent spawned", () => {
  it("keeps a spawned thread out of the rail, including the one on screen", () => {
    const threads = [session("parent"), session("alpha"), session("beta")];
    const parents = { alpha: "parent", beta: "parent" };
    expect(visibleThreads(threads, parents).map((entry) => entry.id)).toEqual(["parent"]);
  });

  it("hides a spawned thread the index named even when no extension published lineage", () => {
    const threads = [spawned("parent"), spawned("alpha", "parent"), spawned("beta", "parent")];
    expect(visibleThreads(threads, {}).map((entry) => entry.id)).toEqual(["parent"]);
  });
});

describe("findProjectForSession", () => {
  const projects = [
    { name: "tau", path: "/repos/tau", lastOpenedAt: 2, icon: "data:image/svg+xml;tau" },
    { name: "satchel", path: "/repos/satchel", lastOpenedAt: 1, icon: "data:image/svg+xml;satchel" },
  ];

  it("finds project by exact path", () => {
    expect(findProjectForSession(projects, { projectPath: "/repos/tau", projectName: "tau" })?.icon).toBe("data:image/svg+xml;tau");
  });

  it("finds project for a worktree by projectName when path differs", () => {
    expect(findProjectForSession(projects, { projectPath: "/worktrees/tau-feat", projectName: "tau" })?.icon).toBe("data:image/svg+xml;tau");
  });

  it("finds project for a worktree by subpath", () => {
    expect(findProjectForSession(projects, { projectPath: "/repos/tau/sub-worktree" })?.icon).toBe("data:image/svg+xml;tau");
  });

  it("returns undefined when no project matches", () => {
    expect(findProjectForSession(projects, { projectPath: "/other/unknown", projectName: "unknown" })).toBeUndefined();
  });
});
