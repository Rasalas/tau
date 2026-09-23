import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./src/renderer/components/Markdown";
import { withoutSvgAttributes } from "./vite.markdown-schema";

const INDEX = createRequire(import.meta.url).resolve("property-information");

describe("withoutSvgAttributes", () => {
  // Guards an upgrade: the build throws when the index no longer has this shape.
  it("drops only the SVG table from the installed package", () => {
    const source = readFileSync(INDEX, "utf8");
    const result = withoutSvgAttributes(source);
    expect(result).not.toContain("./lib/svg.js");
    expect(result).toContain("export const svg = merge([aria, xlink, xmlns, xml], 'svg')");
    const html = /export const html = .*/u.exec(source)![0];
    expect(result).toContain(html);
  });

  it("rejects an index it does not know", () => {
    expect(() => withoutSvgAttributes("export const svg = {}")).toThrow(/revisit/u);
  });

  it("is safe because Markdown never draws an SVG element", () => {
    const markup = renderToStaticMarkup(createElement(Markdown, null, [
      '<svg viewBox="0 0 8 8"><path d="M0 0h8"/></svg>',
      "",
      'Inline <svg width="4"><circle r="2"/></svg> too.',
    ].join("\n")));
    expect(markup).not.toMatch(/<svg|<path|<circle/u);
    expect(markup).toContain("&lt;svg");
  });
});
