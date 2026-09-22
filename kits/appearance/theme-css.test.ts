import { describe, expect, it } from "vitest";
import { parseThemeCss, previewCss, runtimeCss, schemeSides, themeFileCss } from "./theme-css.js";

describe("theme stylesheets", () => {
  it("splits light-dark() at its top-level comma only", () => {
    expect(schemeSides("light-dark(#fff, #000)")).toEqual({ light: "#fff", dark: "#000" });
    expect(schemeSides("light-dark(hsl(var(--h) 46% 88%), hsl(var(--h) 34% 15%))")).toEqual({ light: "hsl(var(--h) 46% 88%)", dark: "hsl(var(--h) 34% 15%)" });
    expect(schemeSides("#123456")).toEqual({ light: "#123456", dark: "#123456" });
  });

  it("reads a theme's tokens per scheme from its color-scheme, its base or both", () => {
    const dark = parseThemeCss(":root { color-scheme: dark; --shell: #111; --acid: light-dark(#0a0, #0f0); }");
    expect(dark.dark).toEqual({ "--shell": "#111", "--acid": "#0f0" });
    expect(dark.light).toEqual({ "--acid": "#0a0" });
    expect(parseThemeCss(":root { --shell: #eee; }", "light")).toEqual({ light: { "--shell": "#eee" }, dark: {} });
    expect(parseThemeCss("/* --x: #fff; */ :root { --shell: #eee; }")).toEqual({ light: { "--shell": "#eee" }, dark: { "--shell": "#eee" } });
  });

  it("writes the editor's theme as a file the theme list reads back", () => {
    const css = themeFileCss({ id: "ember", name: "Ember */", appearance: "dark", tokens: { "--shell": "#1a1010", "--acid": "#ff6a00" } });
    expect(css).toContain("/* theme: Ember  */");
    expect(css).toContain(':root, :root[data-theme="ember"] {');
    expect(parseThemeCss(css).dark).toEqual({ "--shell": "#1a1010", "--acid": "#ff6a00" });
    expect(parseThemeCss(css).light).toEqual({});
  });

  it("applies a theme per scheme under System, Light and Dark", () => {
    const css = runtimeCss({ light: { "--shell": "#fff" }, dark: { "--shell": "#000" }, contrast: 0 });
    expect(css).toContain(':root[data-theme="light"] { --shell: #fff; }');
    expect(css).toContain('@media (prefers-color-scheme: dark) { :root[data-theme="system"] { --shell: #000; } }');
    expect(runtimeCss({ contrast: 0 })).toBe("");
  });

  it("raises contrast by mixing on <body> what <html> keeps under another name", () => {
    const css = runtimeCss({ contrast: 40 });
    expect(css).toContain("--tau-appearance-base-line: var(--line);");
    expect(css).toContain("--line: color-mix(in oklab, var(--tau-appearance-base-line), var(--ink) 14%);");
    expect(css).toContain("--muted: color-mix(in oklab, var(--tau-appearance-base-muted), var(--ink) 20%);");
  });

  it("drops a value that could end its declaration", () => {
    expect(previewCss("dark", { "--shell": "#000", "--ink": "#fff; } body { x: y" })).toBe(":root:root { color-scheme: dark; --shell: #000; }");
  });
});
