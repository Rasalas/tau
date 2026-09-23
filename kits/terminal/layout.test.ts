import { describe, expect, it } from "vitest";
import {
  addGroup, detachPane, EMPTY_LAYOUT, focusedPane, focusNext, focusPane, isStaged, moveDivider, moveToStage, nextPane, pane, paneIds,
  parseLayout, reconcileLayout, removePane, replacePane, resizeGroupSplit, resizeSplit, restoreStageGroup, returnFromStage, splitAt,
  splitPane, stageGroup, type PaneNode,
} from "./layout.js";

const row = (...children: PaneNode[]): PaneNode => ({ kind: "split", direction: "right", children });
const column = (...children: PaneNode[]): PaneNode => ({ kind: "split", direction: "down", children });
const sized = (node: PaneNode, sizes: number[]): PaneNode => ({ ...node, sizes } as PaneNode);
/** Shares to six places, so float noise does not fail a comparison. */
const approx = (node: PaneNode | undefined): PaneNode | undefined => node?.kind === "split"
  ? { ...node, children: node.children.map((child) => approx(child)!), ...(node.sizes ? { sizes: node.sizes.map((size) => Math.round(size * 1e6) / 1e6) } : {}) }
  : node;
const staged = (...ids: string[]) => ids.map((id) => ({ id, root: pane(id), focused: id }));

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
    expect(detachPane(layout, "d")).toEqual({ groups: [], stage: [] });
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
    expect(layout.stage).toEqual(staged("b"));
    expect(isStaged(layout, "b")).toBe(true);
    expect(layout.groups[0]!.root).toEqual(pane("a"));
    // Reconcile must not give a staged shell a panel tab.
    expect(reconcileLayout(layout, ["a", "b"])).toEqual(layout);
    layout = returnFromStage(layout, "b");
    expect(layout.stage).toEqual([]);
    expect(layout.groups.map((group) => paneIds(group.root))).toEqual([["a"], ["b"]]);
    expect(returnFromStage(layout, "b")).toBe(layout);
  });

  it("splits inside a stage tab, and gives the whole tree back when the tab closes", () => {
    let layout = moveToStage(addGroup(EMPTY_LAYOUT, "a"), "a");
    layout = splitAt(layout, "a", "b", "down");
    expect(layout.groups).toEqual([]);
    expect(stageGroup(layout, "a")).toEqual({ id: "a", root: column(pane("a"), pane("b")), focused: "b" });
    // Focus inside a stage tab leaves the panel's active tab alone.
    layout = addGroup(layout, "c");
    expect(focusPane(layout, "a").active).toBe("group-c");
    expect(stageGroup(focusNext(layout, 1, "b"), "a")!.focused).toBe("a");
    // The tab keeps its id when the shell it was opened with closes.
    expect(stageGroup(detachPane(layout, "a"), "a")!.root).toEqual(pane("b"));
    expect(detachPane(detachPane(layout, "a"), "b").stage).toEqual([]);

    layout = returnFromStage(layout, "a");
    expect(layout.stage).toEqual([]);
    expect(layout.groups.map((group) => group.root)).toEqual([pane("c"), column(pane("a"), pane("b"))]);
    expect(layout.active).toBe("group-a");
  });

  it("restores a stage tab from its group, or stages the shell an older tab names", () => {
    const layout = splitAt(moveToStage(addGroup(EMPTY_LAYOUT, "a"), "a"), "a", "b", "right");
    expect(restoreStageGroup(layout, "a")).toBe(layout);
    expect(restoreStageGroup(addGroup(EMPTY_LAYOUT, "x"), "x")).toEqual({ groups: [], stage: staged("x") });
  });

  it("never gives two tabs one id", () => {
    // "group-a" still holds b when a comes back from the stage.
    let layout = splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "right");
    layout = returnFromStage(moveToStage(layout, "a"), "a");
    expect(layout.groups.map((group) => group.id)).toEqual(["group-a", "group-a-2"]);
  });

  it("puts a restarted shell where the ended one was", () => {
    let layout = splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "down");
    layout = replacePane(layout, "b", "b2");
    expect(layout.groups[0]).toMatchObject({ root: column(pane("a"), pane("b2")), focused: "b2" });
    expect(replacePane(moveToStage(layout, "a"), "a", "a2").stage).toEqual([{ id: "a", root: pane("a2"), focused: "a2" }]);
  });

  it("reconciles with the host: gone shells leave, unplaced ones get tabs unless held", () => {
    let layout = splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "right");
    layout = moveToStage(layout, "gone-too");
    layout = reconcileLayout(layout, ["b", "c", "d"], new Set(["d"]));
    expect(layout.groups.map((group) => paneIds(group.root))).toEqual([["b"], ["c"]]);
    expect(layout.stage).toEqual([]);
    expect(reconcileLayout(layout, [])).toEqual({ groups: [], stage: [] });
  });

  it("reads a stored layout back and refuses one that does not parse", () => {
    let layout = moveToStage(splitAt(addGroup(EMPTY_LAYOUT, "a"), "a", "b", "down"), "c");
    layout = resizeGroupSplit(layout, "group-a", [], [0.7, 0.3]);
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    expect(parseLayout({ groups: [{ id: "g", focused: "a", root: { kind: "split", direction: "sideways", children: [] } }], stage: [] })).toEqual(EMPTY_LAYOUT);
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(parseLayout({ groups: [{ id: "g", focused: "a", root: pane("a") }], stage: [], active: "missing" }).active).toBe("g");
    // Shares that do not fit are dropped, the tree is kept.
    expect(parseLayout({ groups: [{ id: "g", focused: "a", root: { ...row(pane("a"), pane("b")), sizes: [1] } }], stage: [] }).groups[0]!.root).toEqual(row(pane("a"), pane("b")));
  });

  it("reads a layout from before stage tabs held splits", () => {
    expect(parseLayout({ groups: [{ id: "g", focused: "a", root: pane("a") }], onStage: ["b"], active: "g" })).toEqual({
      groups: [{ id: "g", focused: "a", root: pane("a") }], stage: staged("b"), active: "g",
    });
  });
});

describe("split sizes", () => {
  it("moves one divider between its two panes, never under the minimum", () => {
    expect(moveDivider([0.5, 0.5], 1, 0.2).map((share) => Math.round(share * 100) / 100)).toEqual([0.7, 0.3]);
    expect(moveDivider([0.5, 0.5], 1, 0.9).map((share) => Math.round(share * 100) / 100)).toEqual([0.9, 0.1]);
    expect(moveDivider([0.25, 0.25, 0.5], 2, -0.2).map((share) => Math.round(share * 100) / 100)).toEqual([0.25, 0.1, 0.65]);
    expect(moveDivider([0.5, 0.5], 0, 0.2)).toEqual([0.5, 0.5]);
  });

  it("resizes the split a path names and ignores shares that do not fit", () => {
    const tree = row(pane("a"), column(pane("b"), pane("c")));
    expect(approx(resizeSplit(tree, [1], [3, 1]))).toEqual(approx(row(pane("a"), sized(column(pane("b"), pane("c")), [0.75, 0.25]))));
    expect(approx(resizeSplit(tree, [], [0.99, 0.01]))).toEqual(approx(sized(tree, [0.99 / 1.09, 0.1 / 1.09])));
    expect(resizeSplit(tree, [0], [0.5, 0.5])).toBe(tree);
    expect(resizeSplit(tree, [], [1, 1, 1])).toBe(tree);
  });

  it("halves the target's share for a new sibling, and hands a closed pane's share to the rest", () => {
    const tree = sized(row(pane("a"), pane("b")), [0.6, 0.4]);
    expect(approx(splitPane(tree, "b", "c", "right"))).toEqual(approx(sized(row(pane("a"), pane("b"), pane("c")), [0.6, 0.2, 0.2])));
    expect(approx(removePane(sized(row(pane("a"), pane("b"), pane("c")), [0.6, 0.2, 0.2]), "c"))).toEqual(approx(sized(row(pane("a"), pane("b")), [0.75, 0.25])));
    // A merged child split keeps its panes' part of the parent's length.
    const nested = sized(row(pane("a"), column(sized(row(pane("b"), pane("c")), [0.5, 0.5]), pane("d"))), [0.5, 0.5]);
    expect(approx(removePane(nested, "d"))).toEqual(approx(sized(row(pane("a"), pane("b"), pane("c")), [0.5, 0.25, 0.25])));
    // Never resized, never sized.
    expect(removePane(row(pane("a"), pane("b"), pane("c")), "b")).toEqual(row(pane("a"), pane("c")));
  });
});
