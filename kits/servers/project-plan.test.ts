import { describe, expect, it } from "vitest";
import {
  BIG_FOLDER_BYTES, defaultExcluded, excludeLinesFor, excludedFolderLines, newProjectGitignore, normalizeExcluded,
  projectFolderName, selectedTotals, serverStateMessage,
} from "./project-plan.js";

const MB = 1024 * 1024;
const folder = (path: string, bytes: number, files = 1) => ({ path, bytes, files });

describe("the size overview's defaults", () => {
  it("leaves out the named folders at either level, a big second-level folder, and a top folder still big without them", () => {
    const folders = [
      folder("cache", 1 * MB),
      folder("wp-content", 400 * MB, 900),
      folder("wp-content/uploads", 300 * MB, 700),
      folder("wp-content/plugins", 20 * MB, 150),
      folder("wp-content/backups", 70 * MB, 10),
      folder("media", 60 * MB, 40),
      folder("media/a", 30 * MB, 20),
      folder("media/b", 30 * MB, 20),
      folder("lib", 2 * MB, 30),
      folder("lib/vendor", 1 * MB, 10),
      folder("Node_Modules", 1 * MB),
    ];
    expect(defaultExcluded(folders)).toEqual(["Node_Modules", "cache", "lib/vendor", "media", "wp-content/backups", "wp-content/uploads"]);
    // 400 − 300 − 70 = 30 MB left: wp-content itself stays.
    expect(defaultExcluded([folder("big", BIG_FOLDER_BYTES + 1)])).toEqual(["big"]);
    expect(defaultExcluded([folder("edge", BIG_FOLDER_BYTES)])).toEqual([]);
  });

  it("counts what still comes down", () => {
    const summary = { files: 100, bytes: 1000, folders: [folder("a", 400, 40), folder("a/b", 100, 10), folder("c", 50, 5)] };
    expect(selectedTotals(summary, ["a/b", "a", "c"])).toEqual({ files: 55, bytes: 550 });
    expect(selectedTotals(summary, ["a/b"])).toEqual({ files: 90, bytes: 900 });
    expect(normalizeExcluded(["/a/b/", "a", "a", "c/"])).toEqual(["a", "c"]);
  });
});

describe("what goes into Git's ignore lists", () => {
  it("writes a .gitignore that names the deselected folders and the sftp.json", () => {
    expect(newProjectGitignore(["wp-content/uploads", "cache"], ".vscode/sftp.json")).toBe([
      "# Left on the server when this project was made; Tau neither downloads nor uploads them.",
      "/cache/",
      "/wp-content/uploads/",
      "",
      "# The link to the server, for Tau and the VS Code SFTP extension; it stays on this machine.",
      "/.vscode/sftp.json",
      "",
    ].join("\n"));
    expect(newProjectGitignore([], ".vscode/sftp.json")).not.toContain("Left on the server");
    expect(excludedFolderLines(["uploads"], "public")).toEqual(["/public/uploads/"]);
  });

  it("moves sftp.json ignore patterns below the target's folder", () => {
    expect(excludeLinesFor([".vscode", "/dist/", "# note", "", "!keep.log"], "")).toEqual([".vscode", "/dist/", "!keep.log"]);
    expect(excludeLinesFor(["node_modules", "/build/", "logs/*.log", "!keep.log", "cache/"], "app")).toEqual([
      "/app/**/node_modules", "/app/build/", "/app/logs/*.log", "!/app/**/keep.log", "/app/**/cache/",
    ]);
  });
});

describe("names", () => {
  it("says where the first commit comes from and picks a folder name", () => {
    expect(serverStateMessage("fake", "/srv/site", new Date("2026-09-25T10:00:00Z"))).toBe("Server state fake:/srv/site 2026-09-25");
    expect(projectFolderName("/var/www/shop/", "fake")).toBe("shop");
    expect(projectFolderName("/", "deploy@host")).toBe("deploy-host");
    expect(projectFolderName("/srv/.hidden", "x")).toBe("hidden");
  });
});
