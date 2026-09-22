import { describe, expect, it } from "vitest";
import { RETAINED_LINES, Scrollback } from "./retention.js";

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `line ${from + index}\n`).join("");

describe("Scrollback", () => {
  it("keeps everything below the caps, in order", () => {
    const scrollback = new Scrollback();
    scrollback.append("a\n");
    scrollback.append("b");
    scrollback.append("c\n");
    expect(scrollback.text()).toBe("a\nbc\n");
    expect(scrollback.lineCount).toBe(2);
  });

  it("drops whole old lines past the line cap, across chunk boundaries", () => {
    const scrollback = new Scrollback(3, 1_000);
    scrollback.append("one\ntw");
    scrollback.append("o\nthree\n");
    scrollback.append("four\nfive");
    expect(scrollback.text()).toBe("two\nthree\nfour\nfive");
    expect(scrollback.lineCount).toBe(3);
    scrollback.append("\nsix\n");
    expect(scrollback.text()).toBe("four\nfive\nsix\n");
  });

  it("holds the shipped cap of 5,000 lines", () => {
    const scrollback = new Scrollback();
    for (let start = 0; start < 12_000; start += 1_000) scrollback.append(lines(start, start + 1_000));
    const text = scrollback.text();
    expect(scrollback.lineCount).toBe(RETAINED_LINES);
    expect(text.startsWith("line 7000\n")).toBe(true);
    expect(text.endsWith("line 11999\n")).toBe(true);
  });

  it("caps one endless line by characters", () => {
    const scrollback = new Scrollback(100, 10);
    scrollback.append("x".repeat(25));
    expect(scrollback.text()).toBe("x".repeat(10));
  });

  it("moves a character cut to the next line start when one is near", () => {
    const scrollback = new Scrollback(100, 10);
    scrollback.append("abcdef\nghij\nkl");
    expect(scrollback.text()).toBe("ghij\nkl");
  });

  it("never splits a surrogate pair", () => {
    const scrollback = new Scrollback(100, 3);
    scrollback.append("😀ab");
    // Cutting one unit would leave the emoji's low half; the cut moves past it.
    expect(scrollback.text()).toBe("ab");
    scrollback.append("c😀");
    expect(scrollback.text()).toBe("c😀");
  });
});
