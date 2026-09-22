import { describe, expect, it } from "vitest";
import { cssFamilyName, DEFAULT_TERMINAL_FONT_SIZE, resolveTerminalFont, splitFamilyList, terminalFontSize, terminalFontStack } from "./font.js";

const PLATFORM_TAIL = "\"SF Mono\", \"SFMono-Regular\", \"Menlo\", \"Consolas\", \"Liberation Mono\"";

describe("terminal font stack", () => {
  it("names concrete faces only, never a CSS variable or ui-monospace", () => {
    const stack = terminalFontStack();
    expect(stack.startsWith(PLATFORM_TAIL)).toBe(true);
    expect(stack).toContain("\"CaskaydiaCove Nerd Font\"");
    expect(stack).toContain("\"PowerlineSymbols\"");
    expect(stack.endsWith(", monospace")).toBe(true);
    expect(terminalFontStack(["var(--mono)", "ui-monospace", "system-ui"])).toBe(stack);
  });

  it("puts the chosen faces first, quoted, and names each face once", () => {
    expect(terminalFontStack(["JetBrains Mono"]).startsWith(`"JetBrains Mono", ${PLATFORM_TAIL}`)).toBe(true);
    expect(terminalFontStack(["Menlo, 'Fira Code'"]).startsWith("\"Menlo\", \"Fira Code\", \"SF Mono\"")).toBe(true);
    expect(terminalFontStack(["monospace"])).toBe(terminalFontStack());
  });

  it("splits a typed list without breaking quoted names", () => {
    expect(splitFamilyList("\"Iosevka, Term\", Menlo ,  'M+ 1m'")).toEqual(["Iosevka, Term", "Menlo", "M+ 1m"]);
    expect(cssFamilyName("\"Bad\\\"Name\"")).toBe("\"BadName\"");
    expect(cssFamilyName("Monospace")).toBe("monospace");
  });

  it("clamps the size to what the grid can draw", () => {
    expect(terminalFontSize(undefined)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(0)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(2)).toBe(6);
    expect(terminalFontSize(64)).toBe(32);
    expect(terminalFontSize(13.3)).toBe(13.5);
  });
});

describe("resolveTerminalFont", () => {
  const ghostty = { families: ["JetBrains Mono"], size: 16, files: ["/config"], problems: [] };

  it("follows the Ghostty config when the user set nothing", () => {
    expect(resolveTerminalFont({}, ghostty)).toEqual({
      family: terminalFontStack(["JetBrains Mono"]), size: 16, face: "JetBrains Mono", familySource: "ghostty", sizeSource: "ghostty",
    });
  });

  it("lets a setting win, family and size each on their own", () => {
    expect(resolveTerminalFont({ family: "Menlo" }, ghostty)).toMatchObject({ face: "Menlo", size: 16, familySource: "settings", sizeSource: "ghostty" });
    expect(resolveTerminalFont({ family: "  ", size: "14" }, ghostty)).toMatchObject({ face: "JetBrains Mono", size: 14, familySource: "ghostty", sizeSource: "settings" });
    expect(resolveTerminalFont({ size: "big" }, ghostty)).toMatchObject({ size: 16, sizeSource: "ghostty" });
  });

  it("falls back to the platform faces without a config", () => {
    expect(resolveTerminalFont({}, undefined)).toEqual({ family: terminalFontStack(), size: DEFAULT_TERMINAL_FONT_SIZE, familySource: "default", sizeSource: "default" });
    expect(resolveTerminalFont({}, { families: [], files: [], problems: [] }).familySource).toBe("default");
  });
});
