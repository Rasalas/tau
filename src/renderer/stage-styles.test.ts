import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SHEETS = ["./styles.css", "./profile-compact.css"].map((path) => new URL(path, import.meta.url));

/** Selectors whose subject is the `.stage` element itself, with the declarations they set. */
async function stageRules(): Promise<Array<{ selector: string; body: string }>> {
  const rules: Array<{ selector: string; body: string }> = [];
  for (const sheet of SHEETS) {
    const css = (await readFile(sheet, "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      for (const selector of selectors.split(",").map((part) => part.trim())) {
        const subject = selector.split(/[\s>+~]+/u).at(-1) ?? "";
        if (/\.stage(?![\w-])/u.test(subject)) rules.push({ selector, body });
      }
    }
  }
  return rules;
}

describe("stage styles", () => {
  // The centre switches between grid and flex at the compact width. Under a
  // size-contained `.stage`, Chromium then leaves `.stage-pane` without a
  // layout box (0x0) until it remounts: a restored terminal tab never painted.
  it("never makes the stage itself a size container", async () => {
    const rules = await stageRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const { selector, body } of rules) {
      expect(body, `${selector} sets container-type`).not.toMatch(/container(-type)?\s*:/u);
    }
  });
});
