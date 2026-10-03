import { describe, expect, it } from "vitest";
import { branchFromField, fetchedAgo, draftProjectName } from "./run-on.js";

describe("a new thread's Run on (design 1k)", () => {
  it("puts a name under tau/ unless it brings its own folder, and leaves an empty one to the prompt", () => {
    expect(branchFromField("pagination")).toBe("tau/pagination");
    expect(branchFromField(" feat/pagination ")).toBe("feat/pagination");
    expect(branchFromField("tau/x")).toBe("tau/x");
    expect(branchFromField("  ")).toBe("");
  });

  it("says how long ago the default base was fetched", () => {
    const now = 1_000_000_000;
    expect(fetchedAgo(undefined, now)).toBeUndefined();
    expect(fetchedAgo(now - 20_000, now)).toBe("fetched just now");
    expect(fetchedAgo(now - 2 * 60_000, now)).toBe("fetched 2m ago");
    expect(fetchedAgo(now - 3 * 3_600_000, now)).toBe("fetched 3h ago");
    expect(fetchedAgo(now - 2 * 86_400_000, now)).toBe("fetched 2d ago");
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
