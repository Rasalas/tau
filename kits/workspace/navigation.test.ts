import { describe, expect, it } from "vitest";
import type { UiSession } from "tau";
import { defaultRailSections, findProjectForSession, navigationRowKey, visibleThreads } from "./navigation.js";
import { railDropAt } from "./rail-drag.js";

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

describe("empty drafts", () => {
  it("keeps a thread nobody wrote to out of the rail until it runs", () => {
    const threads = [session("sent"), { ...session("draft"), messageCount: 0 }];
    expect(visibleThreads(threads, {}).map((entry) => entry.id)).toEqual(["sent"]);
    expect(visibleThreads(threads, {}, (id) => id === "draft").map((entry) => entry.id)).toEqual(["sent", "draft"]);
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

  it("uses the home workspace identity when two machines share a path", () => {
    const copies = [
      { ...projects[0]!, workspaceId: "local", icon: "local-icon" },
      { ...projects[0]!, workspaceId: "remote", icon: "remote-icon" },
    ];
    expect(findProjectForSession(copies, { projectPath: "/repos/tau", workspaceId: "remote" })?.icon).toBe("remote-icon");
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

describe("rail sections", () => {
  it("puts pins first and settled threads on their shelf unless the shelf is off", () => {
    const threads = [{ ...session("new"), modifiedAt: 3 }, { ...session("pinned"), modifiedAt: 1 }, { ...session("done"), modifiedAt: 2 }];
    const [active, settled] = defaultRailSections(threads, ["pinned"], ["done"], true);
    expect(active.threads.map((entry) => entry.id)).toEqual(["pinned", "new"]);
    expect(settled).toMatchObject({ label: "Settled", shelf: true, collapsed: false, settled: true });
    expect(settled.threads.map((entry) => entry.id)).toEqual(["done"]);
    expect(defaultRailSections(threads, [], ["done"], false)[0].threads.map((entry) => entry.id)).toEqual(["new", "done", "pinned"]);
  });

  it("works out where a dragged thread lands from the row or heading under the pointer", () => {
    const sections = [
      { id: "pinned", label: "Pinned", threads: [session("p1"), session("p2")] },
      { id: "active", threads: [session("a1"), session("a2"), session("a3")] },
    ];
    expect(railDropAt(sections, { sectionId: "pinned" }, "a2")).toEqual({ sectionId: "pinned", beforeThreadId: "p1" });
    expect(railDropAt(sections, { sectionId: "pinned", threadId: "p2", after: true }, "a2")).toEqual({ sectionId: "pinned" });
    expect(railDropAt(sections, { sectionId: "active", threadId: "a1", after: false }, "a3")).toEqual({ sectionId: "active", beforeThreadId: "a1" });
    expect(railDropAt(sections, { sectionId: "active", threadId: "a1", after: true }, "a3")).toEqual({ sectionId: "active", beforeThreadId: "a2" });
    // Over its own row the thread stays where it is.
    expect(railDropAt(sections, { sectionId: "active", threadId: "a2", after: true }, "a2")).toEqual({ sectionId: "active", beforeThreadId: "a3" });
    expect(railDropAt(sections, { sectionId: "active", threadId: "a3" }, "a3")).toEqual({ sectionId: "active" });
  });
});
