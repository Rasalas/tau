import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function declarations(selector: string): Promise<string> {
  const css = (await readFile(new URL("./styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) => selectors!.split(",").some((part) => part.trim() === selector))
    .map(([, , body]) => body)
    .join(";");
}

describe("panel styles", () => {
  // A flex item's minimum width is its widest unbreakable line: a long pull request title
  // widened the Changes panel past the window, under the rail, and its buttons out of reach.
  it("lets a panel's body shrink to the panel, whatever its longest line", async () => {
    expect(await declarations(".panel-body")).toMatch(/min-width:\s*0\b/u);
    expect(await declarations(".panel")).toMatch(/min-width:\s*0\b/u);
  });

  it("keeps what a kit adds above the review's file list inside the list", async () => {
    const header = await declarations(".review-list-header");
    expect(header).toMatch(/min-width:\s*0\b/u);
    expect(header).toMatch(/overflow:\s*auto/u);
  });

  // Squeezed beside the file list, its toggle groups shrank and cut off "Split" and "All lines".
  it("scrolls the review's toolbar instead of squeezing its controls", async () => {
    expect(await declarations(".review-toolbar")).toMatch(/overflow-x:\s*auto/u);
    expect(await declarations(".review-toolbar > :not(.review-scope-summary)")).toMatch(/flex-shrink:\s*0/u);
  });
});
