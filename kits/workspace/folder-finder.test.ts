import { describe, expect, it } from "vitest";
import { foldersBelow, groupRepositories, isTypedPath, joinFolder, rankFolders, relativeFolder, type IndexedFolder } from "./folder-finder.js";
import type { UiFolderIndex } from "./protocol.js";

const folder = (path: string, repository?: IndexedFolder["repository"]): IndexedFolder =>
  ({ path, name: path.split("/").pop()!, ...(repository ? { repository } : {}) });

describe("rankFolders", () => {
  it("puts a run of letters at a word start before the same letters spread over a name", () => {
    const ranked = rankFolders([
      folder("_self/tau-worktrees/fix-mobile-thread-menus", "github"),
      folder("_self/tau", "github"),
      folder("_self/transcribe-audio", "github"),
    ], "tau");
    expect(ranked.map((match) => match.path)).toEqual(["_self/tau", "_self/tau-worktrees/fix-mobile-thread-menus", "_self/transcribe-audio"]);
  });

  it("needs every word, in any part of the path", () => {
    const ranked = rankFolders([
      folder("_self/tau-worktrees/fix-mobile-composer", "github"),
      folder("_self/tau-worktrees/fix-desktop-sidebar", "github"),
      folder("_external/mobile-kit", "github"),
    ], "tau mob");
    expect(ranked.map((match) => match.path)).toEqual(["_self/tau-worktrees/fix-mobile-composer"]);
  });

  it("marks the matched letters in the path", () => {
    const [match] = rankFolders([folder("_external/t3code", "github")], "t3");
    expect(match!.marks).toEqual([10, 11]);
  });

  it("ranks a repository above a plain folder of the same name", () => {
    const ranked = rankFolders([folder("archive/notes"), folder("work/notes", "gitlab")], "notes");
    expect(ranked[0]!.path).toBe("work/notes");
  });

  it("finds nothing for an empty query", () => {
    expect(rankFolders([folder("a")], "  ")).toEqual([]);
  });
});

describe("folder paths", () => {
  it("tells a host path from something to find", () => {
    expect(["~", "~/repos", "/Volumes", "C:\\Users", "\\\\server"].map(isTypedPath)).toEqual([true, true, true, true, true]);
    expect(["tau", "~tau", "t3 code"].map(isTypedPath)).toEqual([false, false, false]);
  });

  it("re-roots POSIX and Windows paths below a folder", () => {
    expect(relativeFolder("/repos", "/repos")).toBe("");
    expect(relativeFolder("/repos", "/repos/_self/tau")).toBe("_self/tau");
    expect(relativeFolder("/repos", "/repos-old/x")).toBeUndefined();
    expect(relativeFolder("C:\\code", "C:\\code\\tau\\kits")).toBe("tau/kits");
    expect(joinFolder("/repos/", "_self/tau")).toBe("/repos/_self/tau");
    expect(joinFolder("C:\\code", "tau/kits")).toBe("C:\\code\\tau\\kits");
  });

  it("lists the index's folders below one of them, re-rooted there", () => {
    const index: UiFolderIndex = { root: "/repos", truncated: false, folders: [
      { path: "_self" }, { path: "_self/tau", repository: "github" }, { path: "_selfish", repository: "git" },
    ] };
    expect(foldersBelow(index, "_self")).toEqual([{ path: "tau", name: "tau", repository: "github" }]);
    expect(foldersBelow(index, "").map((entry) => entry.path)).toEqual(["_self", "_self/tau", "_selfish"]);
  });
});

describe("groupRepositories", () => {
  it("groups by the folder right below, those directly inside first, plain folders left out", () => {
    const groups = groupRepositories([
      folder("_external"), folder("_external/t3code", "github"), folder("dotfiles", "git"), folder("_self/tau/kits", "github"),
    ]);
    expect(groups.map((group) => [group.key, group.repositories.map((repository) => repository.path)])).toEqual([
      ["", ["dotfiles"]],
      ["_external", ["_external/t3code"]],
      ["_self", ["_self/tau/kits"]],
    ]);
  });
});
