import { describe, expect, it } from "vitest";
import { clientClause, evaluateWhen, isSpecificWhen, parseWhen, whenOverlaps } from "./keybinding-when";

const holds = (source: string, ...names: string[]) => evaluateWhen(parseWhen(source)!, (name) => names.includes(name));

describe("when clauses", () => {
  it("reads names, negation, && before || and parentheses", () => {
    expect(holds("terminalFocus", "terminalFocus")).toBe(true);
    expect(holds("!terminalFocus", "terminalFocus")).toBe(false);
    expect(holds("terminalFocus && !stageFocus", "terminalFocus")).toBe(true);
    expect(holds("terminalFocus && !stageFocus", "terminalFocus", "stageFocus")).toBe(false);
    expect(holds("a || b && c", "a")).toBe(true);
    expect(holds("(a || b) && c", "a")).toBe(false);
    expect(holds("!!a", "a")).toBe(true);
    expect(holds("true")).toBe(true);
    expect(holds("false || x")).toBe(false);
  });

  it("refuses what is not a clause", () => {
    for (const source of ["", "a &&", "&& a", "(a", "a)", "a b", "a & b", "!", "a || || b", "1a"]) {
      expect(parseWhen(source), source).toBeUndefined();
    }
  });

  it("calls a clause specific when it needs some context to hold", () => {
    expect(isSpecificWhen(undefined)).toBe(false);
    expect(isSpecificWhen(parseWhen("!terminalFocus"))).toBe(false);
    expect(isSpecificWhen(parseWhen("true"))).toBe(false);
    expect(isSpecificWhen(parseWhen("terminalFocus && !stageFocus"))).toBe(true);
    expect(isSpecificWhen(parseWhen("modelPickerOpen"))).toBe(true);
  });

  it("takes isDesktop for the client's, not for a focus a key needs", () => {
    expect(isSpecificWhen(parseWhen("isDesktop"), true)).toBe(false);
    expect(isSpecificWhen(parseWhen("!terminalFocus && isDesktop"), true)).toBe(false);
    expect(isSpecificWhen(parseWhen("terminalFocus && isDesktop"), true)).toBe(true);
    expect(isSpecificWhen(parseWhen("!isDesktop"), false)).toBe(false);
  });

  it("keeps a clause for the other kind of client from ever holding here", () => {
    const desktop = clientClause(true);
    const browser = clientClause(false);
    expect(whenOverlaps(parseWhen("!terminalFocus && isDesktop"), desktop)).toBe(true);
    expect(whenOverlaps(parseWhen("!terminalFocus && isDesktop"), browser)).toBe(false);
    expect(whenOverlaps(parseWhen("terminalFocus && !isDesktop"), browser)).toBe(true);
    expect(whenOverlaps(parseWhen("terminalFocus && !isDesktop"), desktop)).toBe(false);
    expect(whenOverlaps(parseWhen("terminalFocus"), browser)).toBe(true);
  });

  it("knows when two clauses can hold together", () => {
    expect(whenOverlaps(parseWhen("terminalFocus"), parseWhen("!terminalFocus"))).toBe(false);
    expect(whenOverlaps(parseWhen("terminalFocus && !stageFocus"), parseWhen("!terminalFocus"))).toBe(false);
    expect(whenOverlaps(parseWhen("editorFocus"), parseWhen("!terminalFocus"))).toBe(true);
    expect(whenOverlaps(undefined, parseWhen("false"))).toBe(true);
    expect(whenOverlaps(parseWhen("a && !a"), parseWhen("b"))).toBe(false);
  });
});
