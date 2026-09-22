import { describe, expect, it } from "vitest";
import {
  addGroup, detachPane, EMPTY_LAYOUT, focusedPane, focusNext, focusPane, moveToStage, nextPane, pane, paneIds,
  parseLayout, reconcileLayout, removePane, returnFromStage, splitAt, splitPane, type PaneNode,
} from "./layout.js";

const row = (...children: PaneNode[]): PaneNode => ({ kind: "split", direction: "right", children });
const column = (...children: PaneNode[]): PaneNode => ({ kind: "split", direction: "down", children });

describe("split tree", () => {
  it("splits a pane into a row or a column and keeps reading order", () => {
    expect(splitPane(pane("a"), "a", "b", "right")).toEqual(row(pane("a"), pane("b")));
    expect(splitPane(pane("a"), "a", "b", "down")).toEqual(column(pane("a"), pane("b")));
    expect(paneIds(row(pane("a"), column(pane("b"), pane("c"))))).toEqual(["a", "b", "c"]);
  });

  it("adds a sibling when the split runs the same way, and nests when it does not", () => {
    const three = splitPane(row(pane("a"), pane("b")), "a", "c", "right");
    expect(three).toEqual(row(pane("a"), pane("c"), pane("b")));
    expect(splitPane(three, "c", "d", "down")).toEqual(row(pane("a"), column(pane("c"), pane("d")), pane("b")));
  });

  it("leaves a tree alone when the target is not in it", () => {
    const tree = row(pane("a"), pane("b"));
    expect(splitPane(tree, "x", "y", "down")).toEqual(tree);
  });

  it("collapses a split that is left with one pane and merges same-way splits", () => {
    expect(removePane(row(pane("a"), pane("b")), "a")).toEqual(pane("b"));
    expect(removePane(pane("a"), "a")).toBeUndefined();
    // Removing c leaves the column with d alone, which then sits in the row directly.
    expect(removePane(row(pane("a"), column(pane("c"), pane("d")), pane("b")), "c")).toEqual(row(pane("a"), pane("d"), pane("b")));
    // A row inside a column inside a row: removing the column's other child merges the rows.
    expect(removePane(row(pane("a"), column(row(pane("b"), pane("c")), pane("d"))), "d")).toEqual(row(pane("a"), pane("b"), pane("c")));
  });

  it("cycles focus through the panes, both ways", () => {
    const tree = row(pane("a"), column(pane("b"), pane("c")));
    expect(nextPane(tree, "a")).toBe("b");
    expect(nextPane(tree, "c")).toBe("a");
    expect(nextPane(tree, "a", -1)).toBe("c");
    expect(nextPane(tree, "gone")).toBe("a");
  });
});

describe("terminal layout", () => {
  it("opens each new shell in a tab of its own and splits the focused one", () => {
    let layout = addGroup(EMPTY_LAYOUT, "a");
    layout = addGroup(layout, "b");
    expect(layout.groups.map((group) => paneIds(group.root))).toEqual([["a"], ["b"]]);
    expect(focusedPane(layout)).toBe("b");

    layout = splitAt(layout, "a", "c", "right");
    expect(layout.active).toBe("group-a");
    expect(layout.groups[0]!.root).toEqual(row(pane("a"), pane("c")));
    expect(focusedPane(layout)).toBe("c");
  });

  it("moves a shell a split placed out of the tab reconcile gave it", () => {
    let layout = reconcileLayout(addGroup(EMPTY_LAYOUT, "a"), ["a", "b"]);
    expect(layout.groups).toHaveLength(2);
    layout = splitAt(layout, "a", "b", "down");
    expect(layout.groups.map((group) => group.root)).toEqual([column(pane("a"), pane("b"))]);
  });

  it("closes a pane: focus moves to its neighbour, an empty tab goes and the next one shows", () => {
    let layout = splitAt(splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "right"), "b", "c", "right");
    layout = addGroup(layout, "d");
    layout = focusPane(layout, "b");
    expect(layout.active).toBe("group-a");
    layout = detachPane(layout, "b");
    expect(focusedPane(layout)).toBe("a");
    layout = detachPane(detachPane(layout, "a"), "c");
    expect(layout.groups.map((group) => group.id)).toEqual(["group-d"]);
    expect(layout.active).toBe("group-d");
    expect(detachPane(layout, "d")).toEqual({ groups: [], onStage: [] });
  });

  it("moves focus through the active tab only", () => {
    let layout = splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "down");
    layout = addGroup(layout, "c");
    expect(focusedPane(focusNext(layout))).toBe("c");
    layout = focusPane(layout, "b");
    expect(focusedPane(focusNext(layout))).toBe("a");
    expect(focusedPane(focusNext(layout, -1))).toBe("a");
  });

  it("hands a shell to the stage and takes it back as a tab of its own", () => {
    let layout = splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "right");
    layout = moveToStage(layout, "b");
    expect(layout.onStage).toEqual(["b"]);
    expect(layout.groups[0]!.root).toEqual(pane("a"));
    // Reconcile must not give a staged shell a panel tab.
    expect(reconcileLayout(layout, ["a", "b"])).toEqual(layout);
    layout = returnFromStage(layout, "b");
    expect(layout.onStage).toEqual([]);
    expect(layout.groups.map((group) => paneIds(group.root))).toEqual([["a"], ["b"]]);
    expect(returnFromStage(layout, "b")).toBe(layout);
  });

  it("reconciles with the host: gone shells leave, unplaced ones get tabs unless held", () => {
    let layout = splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "right");
    layout = moveToStage(layout, "gone-too");
    layout = reconcileLayout(layout, ["b", "c", "d"], new Set(["d"]));
    expect(layout.groups.map((group) => paneIds(group.root))).toEqual([["b"], ["c"]]);
    expect(layout.onStage).toEqual([]);
    expect(reconcileLayout(layout, [])).toEqual({ groups: [], onStage: [] });
  });

  it("reads a stored layout back and refuses one that does not parse", () => {
    const layout = moveToStage(splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "down"), "c");
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    expect(parseLayout({ groups: [{ id: "g", focused: "a", root: { kind: "split", direction: "sideways", children: [] } }], onStage: [] })).toEqual(EMPTY_LAYOUT);
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(parseLayout({ groups: [{ id: "g", focused: "a", root: pane("a") }], onStage: [], active: "missing" }).active).toBe("g");
  });
});
