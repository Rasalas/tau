import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon, type IconNode } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { blankIconKeys } from "./icon-keys";

const ICONS = join(dirname(createRequire(import.meta.url).resolve("lucide-react")), "..", "esm", "icons");

function iconNode(source: string): IconNode | undefined {
  const literal = /const __iconNode = (\[[\s\S]*?\]);\n/u.exec(source)?.[1];
  return literal === undefined ? undefined : new Function(`return ${literal}`)() as IconNode;
}

const withoutKeys = (node: IconNode) => node.map(([tag, { key: _key, ...attributes }]) => [tag, attributes]);

describe("blankIconKeys", () => {
  it("blanks the key of each element in place", () => {
    const code = [
      "const __iconNode = [",
      '  ["path", { d: "M5 12h14", key: "1ays0h" }],',
      "  [",
      '    "circle",',
      "    {",
      '      cx: "12",',
      '      key: "1mglay"',
      "    }",
      "  ]",
      "];",
    ].join("\n");
    const result = blankIconKeys(code);

    expect(result).not.toContain("key");
    expect(result.split("\n").map((line) => line.length)).toEqual(code.split("\n").map((line) => line.length));
    expect(iconNode(`${result}\n`)).toEqual([["path", { d: "M5 12h14" }], ["circle", { cx: "12" }]]);
  });

  it("leaves a key outside an icon's attribute list alone", () => {
    const code = 'const map = { key: "1ays0h", d: "M5 12h14" };';
    expect(blankIconKeys(code)).toBe(code);
  });

  // Guards a lucide upgrade: a new layout would leave keys (and bytes) behind.
  it("strips every key of the installed icon set and nothing else", () => {
    const files = readdirSync(ICONS).filter((file) => file.endsWith(".mjs"));
    let icons = 0;
    for (const file of files) {
      const source = readFileSync(join(ICONS, file), "utf8");
      const original = iconNode(source);
      if (!original) continue;
      icons += 1;
      const stripped = blankIconKeys(source);
      expect(stripped, file).not.toMatch(/\bkey:/u);
      expect(iconNode(stripped), file).toEqual(withoutKeys(original));
    }
    expect(icons).toBeGreaterThan(1000);
  });

  it("renders the same markup without keys", () => {
    // React's development build warns about the keyless list; production does not.
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const file of ["activity.mjs", "settings.mjs", "git-branch.mjs", "square-dashed.mjs", "sliders-vertical.mjs"]) {
      const original = iconNode(readFileSync(join(ICONS, file), "utf8"))!;
      const render = (node: IconNode) => renderToStaticMarkup(createElement(Icon, { iconNode: node, size: 16 }));
      expect(render(withoutKeys(original) as IconNode), file).toBe(render(original));
    }
    warn.mockRestore();
  });
});
