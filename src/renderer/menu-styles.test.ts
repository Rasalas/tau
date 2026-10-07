import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SHEET = new URL("./styles.css", import.meta.url);

describe("menu styles", () => {
  // The project card's `button:hover` rule greyed the whole window behind its editor and Git menus.
  it("keeps the scrim transparent under any container's button rules", async () => {
    const css = (await readFile(SHEET, "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
    const body = css.match(/(^|\})\s*\.menu-scrim\s*\{([^{}]*)\}/u)?.[2] ?? "";
    expect(body).toMatch(/background:\s*transparent\s*!important/u);
  });
});
