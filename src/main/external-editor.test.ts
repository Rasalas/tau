import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openExternalEditor, editorCommandArgv, isTerminalEditor, resolveEditorCommand } from "./external-editor.js";

describe("external-editor", () => {
  it.skipIf(process.platform === "win32")("uses a private temporary directory and file and removes both after editing", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "tau-editor-test-"));
    const report = join(scratch, "report.json");
    const script = `const fs=require('fs'),path=require('path');const file=process.argv[2];fs.writeFileSync(process.env.EDITOR_REPORT,JSON.stringify({file,dirMode:fs.statSync(path.dirname(file)).mode&511,fileMode:fs.statSync(file).mode&511}));`;
    const scriptFile = join(scratch, "editor.cjs");
    await writeFile(scriptFile, script);
    try {
      const result = await openExternalEditor({ editorCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)}`, initialText: "private prompt", platform: "linux", env: { ...process.env, EDITOR_REPORT: report } });
      const saved = JSON.parse(await readFile(report, "utf8"));
      expect(saved.dirMode).toBe(0o700);
      expect(saved.fileMode).toBe(0o600);
      expect(existsSync(dirname(saved.file))).toBe(false);
      expect(result).toEqual({ text: "private prompt", modified: false });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  describe("resolveEditorCommand", () => {
    it("prefers explicit editorCommand over environment variables", () => {
      const command = resolveEditorCommand({
        editorCommand: "code --wait",
        env: { VISUAL: "nvim", EDITOR: "nano" },
      });
      expect(command).toBe("code --wait");
    });

    it("uses VISUAL when editorCommand is not provided", () => {
      const command = resolveEditorCommand({
        env: { VISUAL: "vim", EDITOR: "nano" },
      });
      expect(command).toBe("vim");
    });

    it("uses EDITOR when VISUAL is not provided", () => {
      const command = resolveEditorCommand({
        env: { EDITOR: "nano" },
      });
      expect(command).toBe("nano");
    });

    it("falls back to notepad on win32 and nano elsewhere", () => {
      expect(resolveEditorCommand({ platform: "win32", env: {} })).toBe("notepad");
      expect(resolveEditorCommand({ platform: "darwin", env: {} })).toBe("nano");
      expect(resolveEditorCommand({ platform: "linux", env: {} })).toBe("nano");
    });
  });

  describe("editorCommandArgv", () => {
    it("keeps a plain binary as a single argv entry", () => {
      expect(editorCommandArgv("code", "darwin")).toEqual(["code"]);
      expect(editorCommandArgv("/usr/local/bin/mate", "darwin")).toEqual(["/usr/local/bin/mate"]);
    });

    it("preserves a quoted binary path containing spaces", () => {
      expect(editorCommandArgv('"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"', "darwin")).toEqual([
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      ]);
      expect(editorCommandArgv("'/Applications/My Editor/bin/editor'", "darwin")).toEqual(["/Applications/My Editor/bin/editor"]);
      expect(editorCommandArgv("/Applications/My\\ Editor/bin/editor", "darwin")).toEqual(["/Applications/My Editor/bin/editor"]);
    });

    it("splits command arguments respecting quotes and escapes", () => {
      expect(editorCommandArgv("code -w", "darwin")).toEqual(["code", "-w"]);
      expect(editorCommandArgv("/usr/local/bin/mate -w", "darwin")).toEqual(["/usr/local/bin/mate", "-w"]);
      expect(editorCommandArgv('code --wait --profile "My Profile"', "darwin")).toEqual(["code", "--wait", "--profile", "My Profile"]);
      expect(editorCommandArgv("code --title 'a b' --empty ''", "darwin")).toEqual(["code", "--title", "a b", "--empty", ""]);
    });

    it("falls back to a shell for metacharacter commands", () => {
      for (const command of [
        "code > /tmp/log",
        "code | tee /tmp/log",
        "code; true",
        "$(which code) -w",
        "`which code` -w",
        "code && true",
      ]) {
        expect(editorCommandArgv(command, "darwin")).toBeNull();
      }
    });

    it("reads a Windows command line: backslashes are separators, only double quotes quote", () => {
      expect(editorCommandArgv('"C:\\Program Files (x86)\\Notepad++\\notepad++.exe" -multiInst', "win32"))
        .toEqual(["C:\\Program Files (x86)\\Notepad++\\notepad++.exe", "-multiInst"]);
      expect(editorCommandArgv("code --wait", "win32")).toEqual(["code", "--wait"]);
      expect(editorCommandArgv("C:\\tools\\edit.exe 'x'", "win32")).toEqual(["C:\\tools\\edit.exe", "'x'"]);
      expect(editorCommandArgv("code --wait & pause", "win32")).toBeNull();
      expect(editorCommandArgv('"unterminated', "win32")).toBeNull();
    });

    it("falls back to a shell for malformed quoting", () => {
      expect(editorCommandArgv('"unterminated', "darwin")).toBeNull();
      expect(editorCommandArgv("code \\", "darwin")).toBeNull();
    });
  });

  describe("isTerminalEditor", () => {
    it("identifies known CLI editors", () => {
      expect(isTerminalEditor("nvim")).toBe(true);
      expect(isTerminalEditor("/usr/local/bin/vim")).toBe(true);
      expect(isTerminalEditor("nano -l")).toBe(true);
      expect(isTerminalEditor("helix")).toBe(true);
      expect(isTerminalEditor("code --wait")).toBe(false);
      expect(isTerminalEditor("subl -w")).toBe(false);
      expect(isTerminalEditor('"C:\\Program Files\\Vim\\vim91\\vim.exe"', "win32")).toBe(true);
    });
  });
});
