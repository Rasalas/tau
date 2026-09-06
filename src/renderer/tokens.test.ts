import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { glob } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const TOKENS = new URL("./tokens.css", import.meta.url);
const STYLES = new URL("./styles.css", import.meta.url);
const KITS = fileURLToPath(new URL("../../kits", import.meta.url));

/** A colour written out rather than named: what only `tokens.css` may contain. */
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|(?<!\/\* )\brgba?\(|\bhsla?\((?!var\()/gu;

/** Custom properties the client sets on an element at runtime, not tokens a theme owns. */
const RUNTIME_PROPERTIES = ["--project-hue", "--used", "--keep-clear-x", "--stage-left", "--stage-right", "--composer-inset"];

async function stylesheets(): Promise<Array<{ name: string; css: string }>> {
  const files = [STYLES];
  for await (const path of glob(`${KITS}/*/styles.css`)) files.push(new URL(`file://${path}`));
  return Promise.all(files.map(async (url) => ({ name: fileURLToPath(url), css: await readFile(url, "utf8") })));
}

describe("the token contract", () => {
  it("keeps every colour in tokens.css and nowhere else", async () => {
    for (const { name, css } of await stylesheets()) {
      expect(css.match(RAW_COLOUR) ?? [], `${name} writes a colour instead of naming a token`).toEqual([]);
    }
  });

  it("keeps first paint offline and unblurred", async () => {
    const tokens = await readFile(TOKENS, "utf8");
    expect(tokens).not.toMatch(/@import\s+url\(/u);
    expect(tokens).not.toMatch(/backdrop-filter\s*:/u);
  });

  it("defines every token the stylesheets ask for", async () => {
    const tokens = await readFile(TOKENS, "utf8");
    const defined = new Set([...tokens.matchAll(/^\s*(--[\w-]+):/gmu)].map((match) => match[1]));
    // A token a rule sets on itself (a layout variable, a per-project hue) is
    // the component's own; only the ones a theme may set live in tokens.css.
    const local = new Set<string>(RUNTIME_PROPERTIES);
    const used = new Set<string>();
    for (const { css } of await stylesheets()) {
      for (const match of css.matchAll(/^\s*(--[\w-]+):/gmu)) local.add(match[1]);
      for (const match of css.matchAll(/var\((--[\w-]+)/gu)) used.add(match[1]);
    }
    const missing = [...used].filter((name) => !defined.has(name) && !local.has(name));
    expect(missing).toEqual([]);
  });
});
