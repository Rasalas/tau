import { describe, expect, it } from "vitest";
import type { UiSession } from "../../shared/contracts";
import { navigationRowKey, visibleThreads } from "./project-navigation";

function session(id: string, parentThreadId?: string): UiSession {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    title: id,
    modifiedAt: 1,
    projectPath: "/project",
    projectName: "project",
    messageCount: 1,
    ...(parentThreadId ? { parentThreadId } : {}),
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

/**
 * Lineage is an extension's claim about threads and `parentThreadId` is the
 * index's own record of one; the rail folds both away without knowing which
 * kit made them (ADR 0013).
 */
describe("threads a lineage folds away", () => {
  const threads = [session("parent"), session("alpha"), session("beta")];
  const parents = { alpha: "parent", beta: "parent" };

  it("hides spawned threads until a search or the toggle asks for them", () => {
    expect(visibleThreads(threads, parents, { showAgents: false, searching: false }).map((entry) => entry.id)).toEqual(["parent"]);
    expect(visibleThreads(threads, parents, { showAgents: true, searching: false }).map((entry) => entry.id)).toEqual(["parent", "alpha", "beta"]);
    expect(visibleThreads(threads, parents, { showAgents: false, searching: true }).map((entry) => entry.id)).toEqual(["parent", "alpha", "beta"]);
    // The thread on screen is never hidden, however it was created.
    expect(visibleThreads(threads, parents, { showAgents: false, searching: false, activeThreadId: "beta" }).map((entry) => entry.id))
      .toEqual(["parent", "beta"]);
  });

  it("hides a spawned thread the index named even when no extension published lineage", () => {
    const indexed = [session("parent"), session("alpha", "parent"), session("beta", "parent")];
    expect(visibleThreads(indexed, {}, { showAgents: false, searching: false }).map((entry) => entry.id)).toEqual(["parent"]);
    expect(visibleThreads(indexed, {}, { showAgents: true, searching: false }).map((entry) => entry.id)).toEqual(["parent", "alpha", "beta"]);
    expect(visibleThreads(indexed, {}, { showAgents: false, searching: false, activeThreadId: "alpha" }).map((entry) => entry.id))
      .toEqual(["parent", "alpha"]);
  });
});
