import { describe, expect, it } from "vitest";
import { rankRefs } from "./branch-menu.js";
import { draftProjectName } from "./run-on.js";

describe("a new thread's Run on (design 1k)", () => {
  it("finds a base by its letters in order, whole hits first", () => {
    const refs = ["main", "feat/remote-main", "origin/main", "origin/release"].map((name) => ({ name, isCurrent: false }));
    expect(rankRefs(refs, "orimain").map((ref) => ref.name)).toEqual(["origin/main"]);
    expect(rankRefs(refs, "main").map((ref) => ref.name)).toEqual(["main", "origin/main", "feat/remote-main"]);
    expect(rankRefs(refs, "rmain").map((ref) => ref.name)).toEqual(["origin/main", "feat/remote-main"]);
    // The tighter run of letters first: `orirel` means origin/release, not origin/fix/remote-linking.
    expect(rankRefs([{ name: "origin/fix/remote-linking", isCurrent: false }, { name: "origin/release", isCurrent: false }], "orirel").map((ref) => ref.name)).toEqual(["origin/release", "origin/fix/remote-linking"]);
    expect(rankRefs(refs, "  ")).toBe(refs);
    expect(rankRefs(refs, "pages")).toEqual([]);
  });

});

describe("a draft's project subtitle", () => {
  const scratch = "/private/scratch/43a4e0a4-e1ca-4084-800b-120f8fafa4b2";
  const draft = { projectPath: scratch, workspaceId: "ws-private", projectName: "No project" };
  it("uses a private draft's name when its workspace is absent from projects", () => {
    expect(draftProjectName([], [draft], scratch, "ws-private")).toBe("No project");
    expect(draftProjectName([], [draft], "/different/display/path", "ws-private")).toBe("No project");
  });
  it("prefers the project's current name and ignores another draft's metadata", () => {
    const project = { path: scratch, workspaceId: "ws-private", name: "Garden" };
    expect(draftProjectName([project], [draft], scratch, "ws-private")).toBe("Garden");
    expect(draftProjectName([], [draft], "/work/Tools", "ws-other")).toBe("Tools");
  });
});
