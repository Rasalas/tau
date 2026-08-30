import { describe, expect, it } from "vitest";
import type { UiSession } from "../../shared/contracts";
import { navigationRowKey } from "./project-navigation";

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
      { kind: "thread" as const, id: "one", session: session("one") },
      { kind: "thread" as const, id: "two", session: session("two") },
    ];
    const reordered = [first[1], first[0]];

    expect(navigationRowKey(first, 0)).toBe("one");
    expect(navigationRowKey(reordered, 0)).toBe("two");
    expect(new Set(reordered.map((_, index) => navigationRowKey(reordered, index)))).toEqual(new Set(["one", "two"]));
  });
});
