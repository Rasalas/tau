import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Every rule of a stylesheet, one entry per selector, comments stripped. */
async function rules(path: string) {
  const css = (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: Array<{ selector: string; body: string }> = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    for (const selector of selectors!.split(/,(?![^(]*\))/u)) found.push({ selector: selector.trim(), body: body! });
  }
  return found;
}

const LOOK = /\b(height|border|border-radius|background|box-shadow|font|padding):/u;

// K55: the task, turn and jump pills in the row over the composer had three sizes, edges and hovers.
describe("the row's pill family", () => {
  it("draws every pill from one rule sized by two tokens", async () => {
    const core = await rules("./styles.css");
    const body = (selector: string) => core.filter((rule) => rule.selector === selector).map((rule) => rule.body).join(";");
    const pill = body(".control-pill");
    expect(pill).toMatch(/height: var\(--control-pill-height\);/u);
    expect(pill).toMatch(/border: 1px solid var\(--line-control\); border-radius: var\(--radius-pill\);/u);
    expect(pill).toMatch(/background: var\(--chrome\);.*box-shadow: var\(--elevation-1\);/u);
    expect(pill).toMatch(/font: 500 13px\/1 var\(--sans\); font-variant-numeric: tabular-nums;/u);
    // Hover and an open detail look the same on every pill.
    expect(body(".control-pill:hover")).toBe(body('.control-pill[aria-expanded="true"]'));
    expect(body(".control-pill:focus-visible")).toMatch(/outline: 2px solid var\(--focus\)/u);
    expect(body(".control-pill > svg")).toMatch(/width: var\(--control-pill-icon\); height: var\(--control-pill-icon\); stroke-width: 2;/u);
    expect(body(".control-pill.icon-only")).toMatch(/width: var\(--control-pill-height\); padding: 0;/u);

    const tokens = await readFile(new URL("./tokens.css", import.meta.url), "utf8");
    expect(tokens).toMatch(/--control-pill-height: 32px;/u);
    expect(tokens).toMatch(/--control-pill-icon: 14px;/u);
    const compact = await rules("./profile-compact.css");
    expect(compact.find((rule) => rule.selector === 'body[data-profile="compact"]' && rule.body.includes("--control-pill-height"))?.body)
      .toMatch(/--control-pill-height: 36px;/u);
    // 44 px to a finger, whatever the pill's height; `::before` starts inside the 1 px border.
    expect(compact.find((rule) => rule.selector === 'body[data-profile="compact"] .control-pill::before')?.body)
      .toMatch(/inset: calc\(\(44px - var\(--control-pill-height\)\) \/ -2 - 1px\);/u);
  });

  it("leaves no pill a size, edge or fill of its own", async () => {
    // A rule on the pill itself (no descendant), apart from the in-transcript turn pill, which is not in the row.
    const own = (found: Array<{ selector: string; body: string }>, pillClass: string) => found
      .filter((rule) => new RegExp(`^\\${pillClass}(?![\\w-])`, "u").test(rule.selector) && !/[\s>]/u.test(rule.selector) && !rule.selector.includes(":not(.control-pill)"))
      .filter((rule) => LOOK.test(rule.body))
      .map((rule) => rule.selector);
    const core = await rules("./styles.css");
    expect([...own(core, ".task-progress-pill"), ...own(core, ".jump-to-latest")]).toEqual([]);
    expect(own(await rules("../../kits/workspace/styles.css"), ".turn-changes-pill")).toEqual([]);
    expect(own(await rules("../../kits/review/styles.css"), ".review-turn-pill")).toEqual([]);
  });
});
