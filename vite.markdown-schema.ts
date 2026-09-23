import type { Plugin } from "vite";

const SCHEMA_INDEX = /[\\/]property-information[\\/]index\.js$/u;
const SVG_IMPORT = "import {svg as svgBase} from './lib/svg.js'";
const SVG_MERGE = "merge([aria, svgBase, xlink, xmlns, xml], 'svg')";

/**
 * Drops the SVG attribute table from `property-information`, which only
 * `hast-util-to-jsx-runtime` imports. Markdown renders no raw HTML, so no `<svg>`
 * element reaches it; the SVG schema keeps its shared attributes (ARIA, xlink, xml).
 */
export function withoutSvgAttributes(code: string): string {
  if (!code.includes(SVG_IMPORT) || !code.includes(SVG_MERGE)) {
    throw new Error("property-information changed its index; revisit vite.markdown-schema.ts");
  }
  return code
    .replace(SVG_IMPORT, "")
    .replace(SVG_MERGE, "merge([aria, xlink, xmlns, xml], 'svg')");
}

export function dropSvgAttributes(): Plugin {
  return {
    name: "tau-drop-svg-attributes",
    transform(code, id) {
      if (!SCHEMA_INDEX.test(id)) return null;
      return { code: withoutSvgAttributes(code), map: null };
    },
  };
}
