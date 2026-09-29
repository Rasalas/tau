import hljs from "highlight.js/lib/core";
import original from "highlight.js/lib/languages/typescript";
import { describe, expect, it } from "vitest";
import typescript from "./highlight-typescript";

// Functions (JSX tag checks) compare by source; everything else by value, shared objects included.
function plain(value: unknown, seen = new Map<object, number>()): unknown {
  if (typeof value === "function") return `fn:${value.toString()}`;
  if (value instanceof RegExp) return `re:${value.toString()}`;
  if (!value || typeof value !== "object") return value;
  const known = seen.get(value);
  if (known !== undefined) return `ref:${known}`;
  seen.set(value, seen.size);
  if (Array.isArray(value)) return value.map((entry) => plain(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry, seen)]));
}

const SAMPLES = [
  "#!/usr/bin/env node\n'use strict';\nimport { a, type B } from \"./b\";\nexport interface Row<T extends object> { id?: string; value: T }\n",
  "@Component({ selector: 'x' })\nexport abstract class Store implements Api {\n  private readonly rows = new Map<string, number>();\n  constructor(public name: string, opt?: number) { super(); }\n  override get size(): number { return this.rows.size satisfies number; }\n}\n",
  "declare namespace NodeJS { interface Global { x: unknown } }\nenum Tone { Calm = 1, Loud }\ntype Pick2<T, K extends keyof T> = { [P in K]: T[P] };\nconst f = async <T,>(value: T): Promise<T> => value as T;\nfunction g(this: Window, ...rest: never[]): void {}\n",
  "const el = <div className=\"x\">{items.map((item) => <Row key={item.id} {...item} />)}</div>;\nlet n = 0x1f_ffn + 1_000.5e3; const re = /a\\/b[c]/giu; const s = `t ${n}`;\n",
];

describe("TypeScript on highlight.js's JavaScript grammar", () => {
  it("builds the same grammar as highlight.js's own", () => {
    expect(plain(typescript(hljs))).toEqual(plain(original(hljs)));
  });

  it("highlights like highlight.js's own", () => {
    const ours = hljs.newInstance();
    ours.registerLanguage("typescript", typescript);
    const theirs = hljs.newInstance();
    theirs.registerLanguage("typescript", original);
    for (const code of SAMPLES) {
      expect(ours.highlight(code, { language: "typescript", ignoreIllegals: true }).value)
        .toBe(theirs.highlight(code, { language: "typescript", ignoreIllegals: true }).value);
    }
  });
});
