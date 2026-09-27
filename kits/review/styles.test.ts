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
  it("wraps the request line and cuts a long linked title instead of widening the list", async () => {
    expect(await declarations(".request-line")).toMatch(/flex-wrap:\s*wrap/u);
    const title = await declarations(".request-link-title");
    expect(title).toMatch(/min-width:\s*0\b/u);
    expect(title).toMatch(/text-overflow:\s*ellipsis/u);
  });
});
