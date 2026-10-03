import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function declarations(selector: string): Promise<string> {
  const css = (await readFile(new URL("./styles.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) => selectors!.split(",").some((part) => part.trim() === selector))
    .map(([, , body]) => body)
    .join(";");
}

describe("Review Kit styles", () => {
  it("hides the mini diff only on rows with a request badge", async () => {
    expect(await declarations(".thread-row:has(.request-badge) .thread-diff-stat")).toMatch(/display:\s*none\b/u);
    expect(await declarations(".thread-diff-stat")).not.toMatch(/display:\s*none\b/u);
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
});
