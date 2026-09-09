import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserThemeResolver } from "./user-themes.js";

describe("UserThemeResolver", () => {
  let tempDir: string;
  let globalThemesDir: string;
  let projectThemesDir: string;
  let resolver: UserThemeResolver;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tau-themes-test-"));
    globalThemesDir = join(tempDir, "global-themes");
    projectThemesDir = join(tempDir, "project-themes");
    await mkdir(globalThemesDir, { recursive: true });
    await mkdir(projectThemesDir, { recursive: true });

    resolver = new UserThemeResolver({
      globalThemesDir,
      projectThemesDir: () => projectThemesDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty list when directories are empty", async () => {
    const themes = await resolver.list();
    expect(themes).toEqual([]);
  });

  it("parses CSS theme files and extracts name comment if present", async () => {
    const cssContent = `/* Theme: Nord Snow */\n:root { --acid: #88c0d0; }`;
    await writeFile(join(globalThemesDir, "nord.css"), cssContent, "utf8");

    const themes = await resolver.list();
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe("nord");
    expect(themes[0].name).toBe("Nord Snow");
    expect(themes[0].css).toBe(cssContent);
    expect(themes[0].sourcePath).toBe(join(globalThemesDir, "nord.css"));
  });

  it("parses JSON theme files and generates CSS tokens", async () => {
    const jsonContent = JSON.stringify({
      name: "Dracula Custom",
      base: "dark",
      variables: {
        "--acid": "#ff79c6",
        "focus": "#bd93f9",
      },
    });
    await writeFile(join(globalThemesDir, "dracula.json"), jsonContent, "utf8");

    const themes = await resolver.list();
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe("dracula");
    expect(themes[0].name).toBe("Dracula Custom");
    expect(themes[0].base).toBe("dark");
    expect(themes[0].css).toContain("color-scheme: dark;");
    expect(themes[0].css).toContain("--acid: #ff79c6;");
    expect(themes[0].css).toContain("--focus: #bd93f9;");
  });

  it("prefers project-level theme over global theme with same id", async () => {
    await writeFile(join(globalThemesDir, "shared.css"), ":root { --acid: blue; }", "utf8");
    await writeFile(join(projectThemesDir, "shared.css"), ":root { --acid: red; }", "utf8");

    const themes = await resolver.list("/mock/project");
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe("shared");
    expect(themes[0].css).toBe(":root { --acid: red; }");
  });
});
