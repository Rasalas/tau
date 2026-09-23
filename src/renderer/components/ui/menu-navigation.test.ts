import { describe, expect, it } from "vitest";
import { firstEnabled, lastEnabled, stepEnabled, typeahead } from "./menu-navigation";

describe("menu navigation", () => {
  const disabled = [false, true, false, false, true];

  it("steps over disabled entries and wraps at both ends", () => {
    expect(stepEnabled(disabled, 0, 1)).toBe(2);
    expect(stepEnabled(disabled, 3, 1)).toBe(0);
    expect(stepEnabled(disabled, 0, -1)).toBe(3);
    expect(firstEnabled(disabled)).toBe(0);
    expect(lastEnabled(disabled)).toBe(3);
    expect(stepEnabled([true, true], 0, 1)).toBe(-1);
  });

  it("jumps to the entry that starts with what was typed, a word at a time", () => {
    const labels = ["Pin thread", "Snooze", "Settle thread", "Archive thread", "Delete"];
    const none = labels.map(() => false);
    let result = typeahead(labels, none, -1, undefined, "s", 1_000);
    expect(result.index).toBe(1);
    result = typeahead(labels, none, result.index, result.state, "e", 1_100);
    expect(result.index).toBe(2);
    // After a pause a new word starts.
    result = typeahead(labels, none, result.index, result.state, "a", 2_000);
    expect(result.index).toBe(3);
  });

  it("walks the entries of one letter when that letter repeats, skipping disabled ones", () => {
    const labels = ["Snooze", "Settle", "Stop", "Save"];
    const off = [false, true, false, false];
    let result = typeahead(labels, off, 0, undefined, "s", 0);
    expect(result.index).toBe(2);
    result = typeahead(labels, off, result.index, result.state, "s", 100);
    expect(result.index).toBe(3);
    result = typeahead(labels, off, result.index, result.state, "s", 200);
    expect(result.index).toBe(0);
  });

  it("stays put when nothing matches", () => {
    expect(typeahead(["Pin"], [false], 0, undefined, "x", 0).index).toBe(0);
  });
});
