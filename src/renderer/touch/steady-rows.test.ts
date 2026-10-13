import { describe, expect, it } from "vitest";
import { MOVED_PRESS_MS, RowPlaces } from "./steady-rows";

const rows = (...ids: string[]) => ids.map((id, index) => ({ id, top: index * 70 }));

describe("row places", () => {
  it("counts no row of the first drawing as moved", () => {
    const places = new RowPlaces();
    places.measure(rows("a", "b"), 1_000);
    expect(places.movedSince("a", 1_000)).toBe(false);
    expect(places.movedSince("b", 1_000)).toBe(false);
  });

  it("knows which rows moved or appeared, until a press comes long enough after", () => {
    const places = new RowPlaces();
    places.measure(rows("a", "b", "c"), 0);
    places.measure(rows("n", "b", "a", "c"), 1_000);
    // `b` is where it was; `n` is new there, `a` and `c` went down.
    expect(["n", "a", "b", "c"].map((id) => places.movedSince(id, 1_200))).toEqual([true, true, false, true]);
    places.measure(rows("n", "b", "a"), 5_000);
    expect(places.movedSince("n", 5_100)).toBe(false);
    expect(places.movedSince("a", 1_000 + MOVED_PRESS_MS)).toBe(false);
    expect(places.movedSince("a", 1_000 + MOVED_PRESS_MS - 1)).toBe(true);
  });

  it("holds no press against a shift it only noticed when the press came", () => {
    const places = new RowPlaces();
    places.measure(rows("a", "b"), 0);
    // A header grew while the list did not render; the press catches up before it counts.
    places.measure(rows("x", "a", "b"), 5_000, false);
    places.measure(rows("x", "a", "b"), 5_010);
    expect(places.movedSince("a", 5_000)).toBe(false);
  });

  it("counts a row that moved after the press began", () => {
    const places = new RowPlaces();
    places.measure(rows("a", "b"), 0);
    places.measure(rows("b", "a"), 10_000);
    expect(places.movedSince("a", 9_000)).toBe(true);
  });
});
