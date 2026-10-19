import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function declarations(selector: string): Promise<string> {
  const css = (await readFile(new URL("./styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) => selectors!.split(",").some((part) => part.trim() === selector))
    .map(([, , body]) => body)
    .join(";");
}

/** The rules inside each `@container rv-main (max-width: …)` block, widest first. */
async function narrowSteps(): Promise<Array<{ width: number; rules: string }>> {
  const css = (await readFile(new URL("./styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...css.matchAll(/@container rv-main \(max-width: (\d+)px\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/gu)]
    .map(([, width, rules]) => ({ width: Number(width), rules: rules! }))
    .sort((left, right) => right.width - left.width);
}

describe("Review Kit styles", () => {
  it("cuts every cell of a review row with an ellipsis instead of letting it run into the next", async () => {
    for (const selector of [".rv-title", ".rv-sub", ".rv-status-text", ".rv-files", ".rv-act-label"]) {
      const rules = await declarations(selector);
      expect(rules, selector).toMatch(/min-width:\s*0\b/u);
      expect(rules, selector).toMatch(/text-overflow:\s*ellipsis/u);
      expect(rules, selector).toMatch(/overflow:\s*hidden/u);
    }
    for (const selector of [".rv-title", ".rv-sub", ".rv-status", ".rv-age"]) expect(await declarations(selector), selector).toMatch(/white-space:\s*nowrap/u);
    // One grid and one height for every row; the button cell has one width.
    expect(await declarations(".rv-row")).toMatch(/grid-template-columns:\s*var\(--rv-grid\)/u);
    expect(await declarations(".rv-row")).toMatch(/height:\s*var\(--rv-row\)/u);
    expect(await declarations(".rv-act")).toMatch(/width:\s*118px/u);
  });

  it("drops the files' count first as the page narrows, then the status's words, then the buttons' labels", async () => {
    const steps = await narrowSteps();
    expect(steps).toHaveLength(3);
    const [files, status, labels] = steps;
    expect(files!.rules).toMatch(/\.rv-files\s*\{\s*display:\s*none/u);
    expect(files!.rules).not.toMatch(/rv-status-text/u);
    expect(status!.rules).toMatch(/\.rv-row \.rv-status-text\s*\{[^}]*clip-path/u);
    expect(labels!.rules).toMatch(/\.rv-row \.rv-act-label\s*\{[^}]*clip-path/u);
    // Every step keeps the grid's six columns.
    for (const step of steps) expect(step.rules).toMatch(/--rv-grid:\s*16px minmax\(0, 1fr\)( \d+px){4};/u);
  });

  it("keeps a sidebar entry on one line of one height, the name cut with an ellipsis", async () => {
    const entry = await declarations(".rv-sidebar button");
    expect(entry).toMatch(/height:\s*32px/u);
    expect(await declarations(".rv-nav-label")).toMatch(/text-overflow:\s*ellipsis/u);
    expect(await declarations(".rv-nav-label")).toMatch(/white-space:\s*nowrap/u);
  });

  it("hides the mini diff only on rows with a request badge", async () => {
    expect(await declarations(".thread-row:has(.request-badge) .thread-diff-stat")).toMatch(/display:\s*none\b/u);
    expect(await declarations(".thread-diff-stat")).not.toMatch(/display:\s*none\b/u);
  });

  it("underlines request links on hover and keyboard focus", async () => {
    for (const selector of ["a.request-badge:hover", "a.request-badge:focus-visible", ".request-card-line button:hover b", ".request-card-line button:focus-visible b"]) {
      expect(await declarations(selector)).toMatch(/text-decoration:\s*underline/u);
    }
    expect(await declarations("a.request-badge")).toMatch(/text-decoration:\s*none/u);
  });

  it("uses the same type size and font for the request number and mini diff", async () => {
    const workspaceCss = await readFile(new URL("../workspace/styles.css", import.meta.url), "utf8");
    const diff = /\.thread-diff-stat\s*\{([^}]*)\}/u.exec(workspaceCss)?.[1];
    const font = /font:\s*var\(--text-xs\) var\(--mono\)/u;
    expect(diff).toMatch(font);
    expect(await declarations(".request-badge")).toMatch(font);
  });

  it("wraps the request line and cuts a long linked title instead of widening the list", async () => {
    expect(await declarations(".request-line")).toMatch(/flex-wrap:\s*wrap/u);
    const title = await declarations(".request-link-title");
    expect(title).toMatch(/min-width:\s*0\b/u);
    expect(title).toMatch(/text-overflow:\s*ellipsis/u);
  });

  it("gives the thread sheet's row actions a finger-sized target and its rows a taller one", async () => {
    const action = await declarations(".thread-sheet-actions > button");
    expect(action).toMatch(/width:\s*var\(--touch-target\)/u);
    expect(action).toMatch(/height:\s*var\(--touch-target\)/u);
    expect(await declarations(".thread-sheet-more")).toMatch(/width:\s*var\(--touch-target\)/u);
    expect(await declarations(".thread-sheet-main")).toMatch(/min-height:\s*56px/u);
  });
});
