import type { HLJSApi, Language, Mode } from "highlight.js";
import javascript from "highlight.js/lib/languages/javascript";

/*
 * highlight.js's TypeScript grammar is its JavaScript grammar plus the changes
 * below, but the package ships it with its own copy of JavaScript. Built on the
 * JavaScript module instead, a TypeScript fence loads a few hundred bytes more
 * than a JavaScript one. Adapted from highlight.js 11 (BSD-3-Clause, © 2006
 * Ivan Sagalaev); `highlight-typescript.test.ts` holds it to the original.
 */

const TYPES = ["any", "void", "number", "boolean", "string", "object", "never", "symbol", "bigint", "unknown"];
const TS_KEYWORDS = ["type", "interface", "public", "private", "protected", "implements", "declare", "abstract", "readonly", "enum", "override", "satisfies"];

type Grammar = Language & { exports: { PARAMS_CONTAINS: unknown[]; CLASS_REFERENCE: Mode }; contains: Mode[] };
type Keywords = { $pattern: string; keyword: string[]; built_in: string[] };

function swapMode(mode: Grammar, label: string, replacement: Mode): void {
  const at = mode.contains.findIndex((entry) => (entry as { label?: string }).label === label);
  if (at === -1) throw new Error("can not find mode to replace");
  mode.contains.splice(at, 1, replacement);
}

export default function typescript(hljs: HLJSApi): Language {
  const ts = javascript(hljs) as Grammar;
  const keywords = ts.keywords as Keywords;
  const ident = keywords.$pattern;
  const decorator = { className: "meta", begin: `@${ident}` };
  // The same arrays object the JavaScript modes hold, so every one of them sees the additions.
  Object.assign(keywords, { keyword: keywords.keyword.concat(TS_KEYWORDS), built_in: keywords.built_in.concat(TYPES) });
  ts.exports.PARAMS_CONTAINS.push(decorator);
  const attribute = ts.contains.find((mode) => mode.scope === "attr")!;
  const optional = Object.assign({}, attribute, { match: hljs.regex.concat(ident, hljs.regex.lookahead(/\s*\?:/)) });
  ts.exports.PARAMS_CONTAINS.push([ts.exports.CLASS_REFERENCE, attribute, optional]);
  ts.contains = ts.contains.concat([
    decorator,
    { begin: [/namespace/, /\s+/, hljs.IDENT_RE], beginScope: { 1: "keyword", 3: "title.class" } },
    {
      beginKeywords: "interface",
      end: /\{/,
      excludeEnd: true,
      keywords: { keyword: "interface extends", built_in: TYPES },
      contains: [ts.exports.CLASS_REFERENCE],
    },
    optional,
  ]);
  swapMode(ts, "shebang", hljs.SHEBANG());
  swapMode(ts, "use_strict", { className: "meta", relevance: 10, begin: /^\s*['"]use strict['"]/ });
  ts.contains.find((mode) => (mode as { label?: string }).label === "func.def")!.relevance = 0;
  return Object.assign(ts, { name: "TypeScript", aliases: ["ts", "tsx", "mts", "cts"] });
}
