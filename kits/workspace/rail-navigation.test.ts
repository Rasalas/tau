import { describe, expect, it } from "vitest";
import type { ClientStorage } from "tau";
import { GROUPS_OPEN_KEY, railKeyDestination, readRailGroupsOpen, reconcileRailCursor, type RailNavigationRow } from "./rail-navigation.js";

const rows: RailNavigationRow[] = [
  { id: "active", kind: "heading", expanded: true },
  { id: "alpha", kind: "heading", parentId: "active", expanded: true, virtualIndex: 0 },
  { id: "a", kind: "thread", parentId: "alpha", virtualIndex: 1 },
  { id: "more", kind: "more", parentId: "alpha", virtualIndex: 2 },
  { id: "beta", kind: "heading", parentId: "active", expanded: false, virtualIndex: 3 },
  { id: "settled", kind: "heading", expanded: false },
];

describe("rail model cursor", () => {
  it("walks groups, More, and collapsed headings in model order", () => {
    expect(railKeyDestination(rows, "a", "Home")).toBe("active");
    expect(railKeyDestination(rows, "a", "End")).toBe("settled");
    expect(railKeyDestination(rows, "alpha", "ArrowDown")).toBe("a");
    expect(railKeyDestination(rows, "a", "ArrowDown")).toBe("more");
    expect(railKeyDestination(rows, "more", "ArrowDown")).toBe("beta");
    expect(railKeyDestination(rows, "beta", "ArrowDown")).toBe("settled");
    expect(railKeyDestination(rows, "active", "ArrowUp")).toBe("settled");
    expect(railKeyDestination(rows, "settled", "ArrowDown")).toBe("active");
  });

  it("uses the real parent, not whichever heading is mounted before the thread", () => {
    expect(railKeyDestination(rows, "a", "ArrowLeft")).toBe("alpha");
    expect(railKeyDestination(rows, "more", "ArrowLeft")).toBe("alpha");
    expect(railKeyDestination(rows, "beta", "ArrowLeft")).toBe("active");
    expect(railKeyDestination(rows, "alpha", "ArrowRight")).toBe("a");
    expect(railKeyDestination(rows, "beta", "ArrowRight")).toBeUndefined();
    expect(railKeyDestination(rows, "a", "ArrowRight")).toBeUndefined();
  });

  it("starts at the active thread, retains identity through reorder, and falls back through deleted ancestors", () => {
    expect(reconcileRailCursor(rows, [], undefined, "a")).toBe("a");
    expect(reconcileRailCursor(rows.slice().reverse(), rows, "a", "other")).toBe("a");
    expect(reconcileRailCursor(rows.filter((row) => !["a", "more"].includes(row.id)), rows, "a")).toBe("alpha");
    expect(reconcileRailCursor(rows.filter((row) => !["alpha", "a", "more"].includes(row.id)), rows, "a")).toBe("active");
    expect(reconcileRailCursor([{ id: "draft", kind: "draft" }], rows, "a")).toBe("draft");
    expect(reconcileRailCursor([], rows, "a")).toBeUndefined();
  });
});

it("loads only boolean group choices and tolerates invalid storage", () => {
  const values = new Map<string, string>();
  const storage: ClientStorage = { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: (key) => { values.delete(key); }, keys: () => [...values.keys()] };
  storage.set(GROUPS_OPEN_KEY, JSON.stringify({ "section:pinned": false, "group:repository:alpha": true, broken: "false" }));
  expect(readRailGroupsOpen(storage)).toEqual({ "section:pinned": false, "group:repository:alpha": true });
  for (const invalid of ["broken", "null", "[]", "3"]) {
    storage.set(GROUPS_OPEN_KEY, invalid);
    expect(readRailGroupsOpen(storage)).toEqual({});
  }
});
