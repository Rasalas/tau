import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One style rule of the renderer's stylesheets: its selectors, split at top-level commas, and its declarations. */
export interface CssRule {
  selectors: string[];
  body: string;
}

function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const char = list[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) { out.push(list.slice(start, index).trim()); start = index + 1; }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** Style rules of CSS text; at-rule wrappers (`@media`, `@supports`) are read as if they applied. */
export function parseCssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/@[a-z-]+[^{;]*\{/gu, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selectors, body]) => ({ selectors: splitSelectors(selectors!), body: body! }));
}

/** Every stylesheet under the renderer (and the kits', when asked), as the app loads them. */
export function rendererCssRules(roots: readonly string[] = [resolve(__dirname, "..")]): CssRule[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".css")) files.push(path);
    }
  };
  roots.forEach(walk);
  return files.flatMap((file) => parseCssRules(readFileSync(file, "utf8")));
}

function matches(element: Element, selector: string): boolean {
  // A pseudo-element's rule styles the box it makes, not the element.
  if (selector.includes("::")) return false;
  try { return element.matches(selector); } catch { return false; }
}

function declares(element: Element, rules: readonly CssRule[], pattern: RegExp): boolean {
  return rules.some((rule) => pattern.test(rule.body) && rule.selectors.some((selector) => matches(element, selector)));
}

const NO_MARKER = /(^|[;\s])list-style(-type)?\s*:\s*none\b/u;
const NOT_LIST_ITEM = /(^|[;\s])display\s*:\s*(?!list-item)[a-z-]+/u;

/**
 * The lists under `root` a browser would draw with a number or a bullet: no
 * rule drops the list's markers, and some item is still a list item. Reads
 * the rules, not computed styles, which jsdom does not cascade.
 */
export function markedLists(root: ParentNode, rules: readonly CssRule[]): Element[] {
  return [...root.querySelectorAll("ol, ul")].filter((list) => {
    if (declares(list, rules, NO_MARKER)) return false;
    const items = [...list.children].filter((child) => child.tagName === "LI");
    return items.some((item) => !declares(item, rules, NO_MARKER) && !declares(item, rules, NOT_LIST_ITEM));
  });
}
