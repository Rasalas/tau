import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** The declarations of each rule whose selector is exactly `selector`. */
async function rule(selector: string): Promise<string> {
  const css = (await readFile(new URL("./styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) => selectors!.split(",").some((part) => part.trim() === selector))
    .map(([, , body]) => body)
    .join(";");
}

describe("terminal styles", () => {
  // A button keeps the browser's own padding unless told otherwise, which moves a glyph off its box's centre.
  it.each([".terminal-tab-close", ".terminal-pane-button", ".terminal-compact-close"])("centres the glyph of %s", async (selector) => {
    const body = await rule(selector);
    expect(body).toMatch(/padding:\s*0\b/u);
    expect(body).toMatch(/place-items:\s*center/u);
  });

  it("gives the phone's close button a 44 px target", async () => {
    expect(await rule(".terminal-compact-close")).toMatch(/width:\s*44px/u);
  });
});
