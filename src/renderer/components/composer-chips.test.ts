import { describe, expect, it } from "vitest";
import {
  chipLabelText,
  chipToken,
  findChipTokens,
  insertChipTokens,
  mirrorSegments,
  plainChipText,
  removeChipToken,
  repairChipTokens,
  tokenAround,
  uniqueChipLabel,
} from "./composer-chips";

const A = chipToken("a.ts");
const B = chipToken("Terminal · 3 lines");

describe("composer chip tokens", () => {
  it("finds tokens and writes them as their labels", () => {
    const text = `look at ${A} and ${B} please`;
    const tokens = findChipTokens(text);
    expect(tokens.map((token) => token.label)).toEqual(["a.ts", "Terminal\u00a0·\u00a03\u00a0lines"]);
    expect(text.slice(tokens[0]!.start, tokens[0]!.end)).toBe(A);
    expect(plainChipText(text)).toBe("look at a.ts and Terminal · 3 lines please");
    expect(plainChipText("no chips")).toBe("no chips");
  });

  it("keeps labels to one line and unique", () => {
    // No-break spaces: a line never breaks inside a chip.
    expect(chipLabelText("  two\nlines\u2063 ")).toBe("two\u00a0lines");
    expect(chipLabelText("x".repeat(80))).toHaveLength(48);
    expect(uniqueChipLabel("a.ts", new Set(["a.ts", "a.ts\u00a02"]))).toBe("a.ts\u00a03");
    expect(uniqueChipLabel("b.ts", new Set(["a.ts"]))).toBe("b.ts");
  });

  it("inserts tokens spaced from the words around them", () => {
    expect(insertChipTokens("fix this", 3, ["a.ts"])).toEqual({ text: `fix ${A} this`, caret: 4 + A.length + 1 });
    expect(insertChipTokens("", 0, ["a.ts", "Terminal · 3 lines"])).toEqual({ text: `${A} ${B} `, caret: A.length + B.length + 2 });
  });

  it("removes a token with the space it came with", () => {
    const text = `fix ${A} this`;
    const [token] = findChipTokens(text);
    expect(removeChipToken(text, token!)).toEqual({ text: "fix this", caret: 4 });
  });

  it("finds the token a caret sits inside", () => {
    const text = `x ${A}`;
    const [token] = findChipTokens(text);
    expect(tokenAround([token!], 2)).toBeUndefined();
    expect(tokenAround([token!], 3)).toBe(token);
    expect(tokenAround([token!], token!.end)).toBeUndefined();
  });

  it("takes the whole chip when an edit cuts into it", () => {
    const previous = `fix ${A} now`;
    const end = 4 + A.length;
    // Backspace right after the token removes its closing mark.
    expect(repairChipTokens(previous, previous.slice(0, end - 1) + previous.slice(end))).toEqual({ text: "fix now", caret: 4 });
    // A word deletion from the middle of the label to after it.
    expect(repairChipTokens(previous, `fix \u2063\u2007\u2007a now`)?.text).toBe("fix now");
    // Typing next to a token, or deleting it whole, leaves it be.
    expect(repairChipTokens(previous, `fix ${A}! now`)).toBeUndefined();
    expect(repairChipTokens(previous, "fix  now")).toBeUndefined();
    expect(repairChipTokens("plain", "plan")).toBeUndefined();
    // Two chips share their first characters; deleting the first whole is not a cut into the second.
    const two = `${chipToken("a.ts")} ${chipToken("b.ts")} `;
    expect(repairChipTokens(two, `${chipToken("b.ts")} `)).toBeUndefined();
  });

  it("splits the text into what the mirror draws", () => {
    expect(mirrorSegments("plain text")).toEqual([]);
    expect(mirrorSegments(`see @src/a.ts and ${A}`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "mention", text: "@src/a.ts" },
      { kind: "text", text: " and " },
      { kind: "chip", text: A, label: "a.ts" },
    ]);
    expect(mirrorSegments("mail a@b.c")).toEqual([]);
    expect(mirrorSegments("/skill:x do it", { start: 0, end: 8 })).toEqual([
      { kind: "skill", text: "/skill:x" },
      { kind: "text", text: " do it" },
    ]);
  });

  it("keeps a long prompt's text whole around its chips", () => {
    const long = `${"word ".repeat(20_000)}${A} ${"tail ".repeat(1_000)}`;
    const segments = mirrorSegments(long);
    expect(segments.map((segment) => segment.text).join("")).toBe(long);
    expect(segments.filter((segment) => segment.kind === "chip")).toHaveLength(1);
  });
});
