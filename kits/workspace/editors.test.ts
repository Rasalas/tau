import { describe, expect, it } from "vitest";
import { editorCommand, findInstalledEditors, type EditorProbe } from "./editors.js";

function probe(options: { platform?: NodeJS.Platform; commands?: Record<string, string>; files?: string[] } = {}): EditorProbe {
  const files = new Set(options.files ?? []);
  return {
    platform: options.platform ?? "darwin",
    home: "/Users/me",
    findCommand: (name) => options.commands?.[name],
    exists: (path) => files.has(path),
  };
}

describe("findInstalledEditors", () => {
  it("lists what is on PATH, what Toolbox installed and the macOS bundles, with Finder last", () => {
    const editors = findInstalledEditors(probe({
      commands: { zed: "/opt/homebrew/bin/zed" },
      files: [
        "/Applications/Visual Studio Code.app",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "/Users/me/Applications/PyCharm CE.app",
        "/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/webstorm",
      ],
    }));
    expect(editors.map((editor) => editor.id)).toEqual(["code", "zed", "pycharm", "webstorm", "file-manager"]);
    expect(editors.find((editor) => editor.id === "code")?.launch).toMatchObject({ kind: "command", command: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" });
    expect(editors.find((editor) => editor.id === "pycharm")?.launch).toEqual({ kind: "app", bundle: "/Users/me/Applications/PyCharm CE.app" });
    expect(editors.at(-1)?.name).toBe("Finder");
  });

  it("finds Toolbox's .cmd launchers on Windows", () => {
    const editors = findInstalledEditors({
      platform: "win32",
      home: "C:\\Users\\me",
      findCommand: (name) => name === "code" ? "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd" : undefined,
      exists: (path) => path === "C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd",
    });
    expect(editors.map((editor) => editor.id)).toEqual(["code", "idea", "file-manager"]);
    expect(editors[1]?.launch).toMatchObject({ kind: "command", command: "C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd" });
  });

  it("names the file manager for the platform and needs xdg-open on Linux", () => {
    expect(findInstalledEditors(probe({ platform: "win32" })).map((editor) => editor.name)).toEqual(["Explorer"]);
    expect(findInstalledEditors(probe({ platform: "linux" }))).toEqual([]);
    expect(findInstalledEditors(probe({ platform: "linux", commands: { "xdg-open": "/usr/bin/xdg-open" } })).map((editor) => editor.name)).toEqual(["Files"]);
  });
});

describe("editorCommand", () => {
  const installed = (commands: Record<string, string>, platform: NodeJS.Platform = "darwin") => findInstalledEditors(probe({ platform, commands }));

  it("opens a file at a line the way each launcher reads one", () => {
    const [cursor, code, zed, idea] = installed({ cursor: "cursor", code: "code", zed: "zed", idea: "idea" });
    const at = { isFile: true, platform: "darwin" as const, position: { line: 12, column: 3 } };
    expect(editorCommand(cursor!, "/p/a.ts", at)).toEqual({ command: "cursor", args: ["--classic", "--goto", "/p/a.ts:12:3"] });
    expect(editorCommand(code!, "/p/a.ts", at)).toEqual({ command: "code", args: ["--goto", "/p/a.ts:12:3"] });
    expect(editorCommand(zed!, "/p/a.ts", at)).toEqual({ command: "zed", args: ["/p/a.ts:12:3"] });
    expect(editorCommand(idea!, "/p/a.ts", at)).toEqual({ command: "idea", args: ["--line", "12", "--column", "3", "/p/a.ts"] });
    expect(editorCommand(code!, "/p", { isFile: false, platform: "darwin", position: { line: 12 } })).toEqual({ command: "code", args: ["/p"] });
  });

  it("reveals a file in the file manager and opens a folder there", () => {
    const finder = installed({}).at(-1)!;
    expect(editorCommand(finder, "/p/a.ts", { isFile: true, platform: "darwin" })).toEqual({ command: "open", args: ["-R", "/p/a.ts"] });
    expect(editorCommand(finder, "/p", { isFile: false, platform: "darwin" })).toEqual({ command: "open", args: ["/p"] });
    const explorer = installed({}, "win32").at(-1)!;
    expect(editorCommand(explorer, "C:\\p\\a.ts", { isFile: true, platform: "win32" })).toEqual({ command: "explorer.exe", args: ["/select,C:\\p\\a.ts"] });
    const files = installed({ "xdg-open": "/usr/bin/xdg-open" }, "linux").at(-1)!;
    expect(editorCommand(files, "/p/src/a.ts", { isFile: true, platform: "linux" })).toEqual({ command: "xdg-open", args: ["/p/src"] });
  });

  it("hands a bundle without a launcher to open -a", () => {
    const [pycharm] = findInstalledEditors(probe({ files: ["/Applications/PyCharm.app"] }));
    expect(editorCommand(pycharm!, "/p/a.py", { isFile: true, platform: "darwin", position: { line: 4 } })).toEqual({ command: "open", args: ["-a", "/Applications/PyCharm.app", "/p/a.py"] });
  });
});
