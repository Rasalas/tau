import { describe, expect, it } from "vitest";
import { contrast } from "./color.js";
import { validateTokens } from "./tokens.js";
import { importVsCodeTheme, parseJsonc } from "./vscode-import.js";

const DARK_JSONC = `{
  // A dark theme the way extensions ship them.
  "name": "night-owl-lite",
  "type": "dark",
  "colors": {
    "editor.background": "#011627",
    "editor.foreground": "#d6deeb", /* the ink */
    "sideBar.background": "#011627ee",
    "focusBorder": "#122d42",
    "button.background": "#7e57c2cc",
    "list.hoverBackground": "#01111d",
    "descriptionForeground": "#0b2942",
    "editorError.foreground": "#ef5350",
    "diffEditor.insertedLineBackground": "#99b76d23",
  },
  "tokenColors": [],
}`;

describe("VS Code theme import", () => {
  it("reads JSONC: comments and trailing commas, not slashes inside strings", () => {
    expect(parseJsonc('{ "url": "https://x.y/z", /* c */ "a": [1, 2,], }')).toEqual({ url: "https://x.y/z", a: [1, 2] });
  });

  it("derives a whole palette from the editor colours and lays what the theme sets over it", () => {
    const theme = importVsCodeTheme(DARK_JSONC);
    expect(theme.name).toBe("Night Owl Lite");
    expect(theme.appearance).toBe("dark");
    expect(theme.tokens["--shell"]).toBe("#011627");
    expect(theme.tokens["--ink"]).toBe("#d6deeb");
    expect(theme.tokens["--hover"]).toBe("#01111d");
    // Translucent colours are flattened onto the surface under them.
    expect(theme.tokens["--rail"]).toMatch(/^#[0-9a-f]{6}$/u);
    expect(theme.tokens["--acid"]).not.toBe("#7e57c2");
    expect(theme.tokens["--fail"]).toBe("#ef5350");
    expect(validateTokens(theme.tokens)).toEqual([]);
  });

  it("keeps a text colour the theme set only where it stays readable", () => {
    const theme = importVsCodeTheme(DARK_JSONC);
    // descriptionForeground is nearly the background: the derived muted ink stays.
    expect(theme.tokens["--muted"]).not.toBe("#0b2942");
    expect(contrast(theme.tokens["--muted"]!, theme.tokens["--shell"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("falls back where the file is silent and tells light from dark without a type", () => {
    const theme = importVsCodeTheme({ name: "Paper", colors: { "editor.background": "#fafafa" } });
    expect(theme.appearance).toBe("light");
    expect(theme.tokens["--ink"]).toBe("#1c1b15");
    expect(Object.keys(theme.tokens).length).toBeGreaterThan(40);
    expect(validateTokens(theme.tokens)).toEqual([]);
  });

  it("says why a file cannot be a palette", () => {
    expect(() => importVsCodeTheme({ colors: {} })).toThrow(/editor.background/u);
    expect(() => importVsCodeTheme("[1, 2]")).toThrow(/one JSON object/u);
    expect(() => importVsCodeTheme("{ nope")).toThrow();
  });
});
