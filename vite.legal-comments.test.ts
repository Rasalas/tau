import { describe, expect, it } from "vitest";
import type { Rollup } from "vite";
import { blankRepeatedLegalComments, dedupeLegalComments } from "./vite.legal-comments";

const NOTICE = "/**\n * @license icons v1 - ISC\n *\n * See the LICENSE file.\n */";

describe("blankRepeatedLegalComments", () => {
  it("keeps the first copy of a notice and blanks the repeats in place", () => {
    const code = `${NOTICE}\nconst a = 1;\n${NOTICE}\nconst b = 2;\n`;
    const result = blankRepeatedLegalComments(code);

    expect(result.match(/@license/gu)).toHaveLength(1);
    expect(result.startsWith(NOTICE)).toBe(true);
    expect(result).toHaveLength(code.length);
    expect(result.split("\n").map((line) => line.length)).toEqual(code.split("\n").map((line) => line.length));
    expect(result).toContain("const b = 2;");
  });

  it("keeps distinct notices and ordinary comments", () => {
    const other = "/*! other v2 | MIT */";
    const code = `${NOTICE}\n${other}\n/** @param a */\nconst glob = "src/**/*.ts"; /* @license in a trailing note */\n`;

    expect(blankRepeatedLegalComments(code)).toBe(code);
  });

  it("blanks every copy of a notice that another chunk keeps", () => {
    const code = `${NOTICE}\nconst a = 1;\n${NOTICE}\n`;
    const result = blankRepeatedLegalComments(code, new Set([NOTICE]));

    expect(result).not.toContain("@license");
    expect(result).toHaveLength(code.length);
  });
});

describe("dedupeLegalComments", () => {
  const OTHER = "/*! @license other v2 | MIT */";
  const chunk = (isEntry: boolean, code: string) => ({ isEntry, modules: { [`${isEntry}.js`]: { code } } }) as unknown as Rollup.RenderedChunk;
  const entry = chunk(true, `${NOTICE}\nexport const icon = 1;`);
  const lazy = chunk(false, `${NOTICE}\n${OTHER}\nexport const other = 2;`);
  const render = (code: string, rendered: Rollup.RenderedChunk) => {
    const hook = dedupeLegalComments().renderChunk as (...args: unknown[]) => { code: string } | null;
    return hook.call({}, code, rendered, {}, { chunks: { "index.js": entry, "lazy.js": lazy } })?.code ?? code;
  };

  it("keeps a notice in the entry chunk and drops the entry's notices from lazy chunks", () => {
    const entryCode = `${NOTICE}\nexport const icon = 1;\n${NOTICE}\n`;
    const lazyCode = `${NOTICE}\n${OTHER}\nexport const other = 2;\n${OTHER}\n`;

    expect(render(entryCode, entry).match(/@license/gu)).toHaveLength(1);
    const lazyResult = render(lazyCode, lazy);
    expect(lazyResult).not.toContain("icons v1");
    expect(lazyResult.match(/other v2/gu)).toHaveLength(1);
  });
});
