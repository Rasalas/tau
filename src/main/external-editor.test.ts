import { describe, expect, it } from "vitest";
import { isTerminalEditor, resolveEditorCommand } from "./external-editor.js";

describe("external-editor", () => {
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

  describe("isTerminalEditor", () => {
    it("identifies known CLI editors", () => {
      expect(isTerminalEditor("nvim")).toBe(true);
      expect(isTerminalEditor("/usr/local/bin/vim")).toBe(true);
      expect(isTerminalEditor("nano -l")).toBe(true);
      expect(isTerminalEditor("helix")).toBe(true);
      expect(isTerminalEditor("code --wait")).toBe(false);
      expect(isTerminalEditor("subl -w")).toBe(false);
    });
  });
});
