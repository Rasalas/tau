import { describe, expect, it } from "vitest";
import { blankRepeatedLegalComments } from "./vite.legal-comments";

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
});
