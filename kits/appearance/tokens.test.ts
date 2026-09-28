import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contrast } from "./color.js";
import { derivePalette } from "./palette.js";
import { TOKEN_GROUPS, TOKEN_NAMES, isThemeId, themeIdFromName, validateTokens } from "./tokens.js";

describe("the tokens a theme may set", () => {
  it("names only tokens core's contract defines", async () => {
    const css = await readFile(new URL("../../src/renderer/tokens.css", import.meta.url), "utf8");
    const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gmu)].map((match) => match[1]));
    expect([...TOKEN_NAMES].filter((name) => !defined.has(name))).toEqual([]);
    expect(TOKEN_GROUPS.map((group) => group.id)).toEqual(["surfaces", "hairlines", "ink", "accent", "status", "diff"]);
  });

  it("accepts known names with hex colours and refuses anything else", () => {
    expect(validateTokens({ "--shell": "#101010", "--acid": "#abc" })).toEqual([]);
    expect(validateTokens({ "--shell": "red" })[0]?.message).toMatch(/needs a colour like/u);
    expect(validateTokens({ "--shell": "#101010; } body { display: none" })).toHaveLength(1);
    expect(validateTokens({ "--space-4": "#101010" })[0]?.message).toMatch(/not a colour token/u);
    expect(validateTokens({ "--shell": "#10101080" })).toHaveLength(1);
  });

  it("turns a name into a file-safe id", () => {
    expect(themeIdFromName("Night Owl (no italics)")).toBe("night-owl-no-italics");
    expect(themeIdFromName("  ")).toBe("");
    expect(isThemeId("night-owl")).toBe(true);
    expect(isThemeId("../etc")).toBe(false);
  });
});

describe("a palette from three colours", () => {
  it("rebuilds Tau's own dark surfaces from its ground, ink and accent", async () => {
    const css = await readFile(new URL("../../src/renderer/tokens.css", import.meta.url), "utf8");
    const dark = new Map([...css.matchAll(/^\s*(--[\w-]+):\s*light-dark\(#[0-9a-f]{6},\s*(#[0-9a-f]{6})\);/gmu)].map((match) => [match[1], match[2]]));
    const tokens = derivePalette({ appearance: "dark", background: dark.get("--shell")!, foreground: dark.get("--ink")!, accent: dark.get("--acid")! });
    const channels = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    // --well stays deeper than the window in a derived theme: an imported ground may be mid-grey.
    const surfaces = TOKEN_GROUPS.find((group) => group.id === "surfaces")!.tokens.map(([name]) => name).filter((name) => name !== "--well");
    for (const name of surfaces) {
      const [want, got] = [channels(dark.get(name)!), channels(tokens[name]!)];
      expect(Math.max(...want.map((value, index) => Math.abs(value - got[index]!))), `${name}: ${tokens[name]} for ${dark.get(name)}`).toBeLessThanOrEqual(2);
    }
  });

  it("keeps every text ink readable on the window and the document area, in both schemes", () => {
    for (const seed of [
      { appearance: "dark" as const, background: "#1e1e1e", foreground: "#d4d4d4", accent: "#0e639c" },
      { appearance: "light" as const, background: "#ffffff", foreground: "#333333", accent: "#005fb8" },
      { appearance: "dark" as const, background: "#282a36", foreground: "#6272a4", accent: "#bd93f9" },
    ]) {
      const tokens = derivePalette(seed);
      for (const ink of ["--ink", "--ink-2", "--ink-3", "--muted", "--acid-text"]) {
        expect(contrast(tokens[ink]!, tokens["--shell"]!), `${ink} on ${seed.background}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens[ink]!, tokens["--stage"]!), `${ink} on the stage`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(tokens["--acid-ink"]!, tokens["--acid"]!)).toBeGreaterThanOrEqual(3);
      expect(validateTokens(tokens)).toEqual([]);
    }
  });
});
