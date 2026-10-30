import { describe, expect, it } from "vitest";
import { parseNumstat, unquoteGitPath } from "./git-output.js";
import { parseWorktrees } from "./worktree-layout.js";

describe("Git paths", () => {
  it("reads NUL worktree records without treating newlines as metadata", () => {
    const path = '/trees/line\n\nbranch refs/heads/other\n"quoted"';
    const output = `worktree /repo\0branch refs/heads/main\0\0worktree ${path}\0branch refs/heads/feature\0\0`;
    expect(parseWorktrees(output, path)).toEqual([
      expect.objectContaining({ path: "/repo", branch: "main", isMain: true }),
      expect.objectContaining({ path, branch: "feature", isCurrent: true, isMain: false }),
    ]);
  });

  it("preserves whitespace, quotes and control characters in NUL-delimited numstat", () => {
    const paths = [" leading.txt", "trailing.txt ", "tab\t.txt", "line\n.txt", '"quoted".txt', "日本語.txt"];
    expect([...parseNumstat(paths.map((path) => `2\t1\t${path}\0`).join(""))])
      .toEqual(paths.map((path) => [path, { added: 2, removed: 1 }]));
  });

  it("keeps a rename's destination verbatim and zeroes binary counts", () => {
    expect([...parseNumstat("0\t0\t\0old\nname\0new\nname \0-\t-\timage.png\0")])
      .toEqual([["new\nname ", { added: 0, removed: 0 }], ["image.png", { added: 0, removed: 0 }]]);
  });

  it("decodes quoted porcelain paths before identifying the current worktree", () => {
    const path = '/trees/café\t"quote"\nend';
    const encoded = '"/trees/caf\\303\\251\\t\\"quote\\"\\nend"';
    expect(unquoteGitPath(encoded)).toBe(path);
    expect(parseWorktrees(`worktree /repo\nbranch refs/heads/main\n\nworktree ${encoded}\nbranch refs/heads/feature\n\n`, path))
      .toEqual([
        { path: "/repo", name: "repo", branch: "main", isMain: true, isCurrent: false },
        { path, name: 'café\t"quote"\nend', branch: "feature", isMain: false, isCurrent: true },
      ]);
    expect(unquoteGitPath("/trees/ leading and trailing ")).toBe("/trees/ leading and trailing ");
  });
});
