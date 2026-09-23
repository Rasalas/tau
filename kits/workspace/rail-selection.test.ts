import { describe, expect, it } from "vitest";
import { NO_SELECTION, selectRange, selectedInOrder, toggleSelected } from "./rail-selection.js";

const order = ["a", "b", "c", "d", "e"];

describe("rail selection", () => {
  it("toggles rows and moves the anchor to the last one toggled", () => {
    const one = toggleSelected(NO_SELECTION, "b");
    const two = toggleSelected(one, "d");
    expect([...two.ids]).toEqual(["b", "d"]);
    expect(two.anchor).toBe("d");
    expect([...toggleSelected(two, "b").ids]).toEqual(["d"]);
  });

  it("selects the run from the anchor in either direction", () => {
    const anchored = toggleSelected(NO_SELECTION, "b");
    expect(selectedInOrder(selectRange(anchored, "d", order), order)).toEqual(["b", "c", "d"]);
    const back = selectRange(selectRange(anchored, "d", order), "a", order);
    expect(selectedInOrder(back, order)).toEqual(["a", "b"]);
    expect(back.anchor).toBe("b");
  });

  it("starts a run at the thread on screen when nothing was toggled yet", () => {
    expect(selectedInOrder(selectRange(NO_SELECTION, "c", order, "e"), order)).toEqual(["c", "d", "e"]);
    expect([...selectRange(NO_SELECTION, "c", order, "gone").ids]).toEqual(["c"]);
  });

  it("counts only selected rows still in view", () => {
    const selection = { ids: new Set(["x", "c", "a"]) };
    expect(selectedInOrder(selection, order)).toEqual(["a", "c"]);
  });
});
