import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// T3 #17962: a long question or permission text pushed the answer buttons off the screen.
describe("a long prompt message", () => {
  it("is capped and scrolls in place, so the footer stays in view", async () => {
    const css = (await readFile(new URL("./styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
    const body = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, selectors]) => selectors!.split(",").some((selector) => selector.trim() === ".extension-prompt-message"))
      .map(([, , rule]) => rule)
      .join(";");
    expect(body).toMatch(/max-height: min\(\d+px, \d+dvh\);/u);
    expect(body).toMatch(/overflow-y: auto;/u);
  });
});
