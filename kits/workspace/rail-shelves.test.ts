import { describe, expect, it } from "vitest";
import type { ClientStorage, UiSession } from "tau";
import { readShelvesOpen, shelfFirstPage, shelfHeading, shelfIsOpen, shelfRows, SHELVES_OPEN_KEY, writeShelvesOpen } from "./rail-shelves.js";
import type { ThreadRailSection } from "./protocol.js";

function createMemoryStorage(): ClientStorage {
  const store = new Map<string, string>();
  return { get: (key) => store.get(key) ?? null, set: (key, value) => { store.set(key, value); }, remove: (key) => { store.delete(key); }, keys: () => [...store.keys()] };
}

const thread = (id: string): UiSession => ({ id, path: `/${id}.jsonl`, title: id, modifiedAt: 1, projectPath: "/p", projectName: "p", messageCount: 1 });
const settled = (count: number): ThreadRailSection => ({
  id: "settled", label: "Settled", shelf: true, collapsed: true, settled: true,
  threads: Array.from({ length: count }, (_, index) => thread(`t${index}`)),
});

describe("the rail's shelves", () => {
  it("start folded unless the client opened them, and remember that choice", () => {
    const storage = createMemoryStorage();
    expect(shelfIsOpen(settled(3), readShelvesOpen(storage))).toBe(false);
    writeShelvesOpen(storage, { settled: true });
    expect(shelfIsOpen(settled(3), readShelvesOpen(storage))).toBe(true);
    // A section that is no shelf is always open.
    expect(shelfIsOpen({ id: "pinned", label: "Pinned", threads: [] }, {})).toBe(true);
  });

  it("read a damaged record as nothing opened", () => {
    const storage = createMemoryStorage();
    storage.set(SHELVES_OPEN_KEY, "not json");
    expect(readShelvesOpen(storage)).toEqual({});
    storage.set(SHELVES_OPEN_KEY, JSON.stringify({ settled: "yes", snoozed: true }));
    expect(readShelvesOpen(storage)).toEqual({ snoozed: true });
  });

  it("draw ten settled rows first, and keep the thread on screen whether folded or paged away", () => {
    const section = settled(40);
    expect(shelfFirstPage(section)).toBe(10);
    expect(shelfRows(section, true, 10, undefined).map((row) => row.id)).toEqual(Array.from({ length: 10 }, (_, index) => `t${index}`));
    expect(shelfRows(section, true, 10, "t33").at(-1)?.id).toBe("t33");
    expect(shelfRows(section, false, 10, undefined)).toEqual([]);
    expect(shelfRows(section, false, 10, "t33").map((row) => row.id)).toEqual(["t33"]);
    expect(shelfRows(section, false, 10, "elsewhere")).toEqual([]);
  });

  it("count their threads only while folded", () => {
    expect(shelfHeading(settled(26), false)).toBe("Settled · 26");
    expect(shelfHeading(settled(26), true)).toBe("Settled");
  });
});
