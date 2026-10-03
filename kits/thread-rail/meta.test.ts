import { describe, expect, it } from "vitest";
import type { UiSession } from "tau";
import {
  DAY_MS,
  EMPTY_STATE,
  applyPatches,
  archivePatch,
  decodeState,
  fallbackThread,
  nextActiveThread,
  inversePatch,
  dropLabel,
  dropPatches,
  nextWake,
  pinPatch,
  railSections,
  linkedRequestThreads,
  requestCheckouts,
  settlePatch,
  snoozePatch,
  snoozePresets,
  sweepPatches,
  unsettlePatch,
} from "./meta.js";
import type { RailState, ThreadMeta } from "./protocol.js";

const NOW = 1_000_000_000_000;

function thread(id: string, modifiedAt = NOW): UiSession {
  return { id, path: `/sessions/${id}.jsonl`, title: id, modifiedAt, projectPath: "/project", projectName: "project", messageCount: 1 };
}

function state(threads: Record<string, ThreadMeta>, settings: Partial<RailState["settings"]> = {}): RailState {
  return { threads, settings: { ...EMPTY_STATE.settings, ...settings } };
}

const ids = (threads: readonly UiSession[]) => threads.map((entry) => entry.id);

describe("thread meta store", () => {
  it("decodes what it wrote and drops what it cannot read", () => {
    const decoded = decodeState({
      version: 1,
      threads: { a: { pinned: true, pinOrder: 2, settledBy: "nonsense" }, b: { junk: 1 }, c: "no" },
      settings: { inactiveDays: 3, onMerged: false },
    });
    expect(decoded).toEqual({ threads: { a: { pinned: true, pinOrder: 2 } }, settings: { inactiveDays: 3, onMerged: false, onClosed: false, workingSection: false } });
    expect(decodeState(undefined)).toEqual(EMPTY_STATE);
  });

  it("patches field by field, forgets a thread whose meta ends up empty, and keeps the object when nothing changed", () => {
    const start = state({ a: { pinned: true, pinOrder: 0 } });
    const unpinned = applyPatches(start, { a: pinPatch(start, "a", false, NOW) });
    expect(unpinned.threads).toEqual({});
    expect(applyPatches(start, { a: { pinned: true } })).toBe(start);
    expect(applyPatches(start, { a: null }).threads).toEqual({});
  });

  it("pins on top of the other pins, and a pin takes a thread off the shelf", () => {
    const start = state({ a: { pinned: true, pinOrder: 0 }, b: { settledAt: 5, settledBy: "user" } });
    const next = applyPatches(start, { b: pinPatch(start, "b", true, NOW) });
    expect(next.threads.b).toEqual({ pinned: true, pinOrder: -1, keptAt: NOW });
  });

  it("settling clears pin, order and snooze; unsettling returns the thread to the top of the active list", () => {
    const start = state({ a: { pinned: true, pinOrder: 0, order: 4, snoozedUntil: NOW + 5 } });
    const settled = applyPatches(start, { a: settlePatch(NOW, "user") });
    expect(settled.threads.a).toEqual({ settledAt: NOW, settledBy: "user" });
    expect(applyPatches(settled, { a: unsettlePatch(NOW + 1) }).threads.a).toEqual({ keptAt: NOW + 1 });
  });
});

describe("rail sections", () => {
  it("files each thread into one section: settled over snoozed over pinned", () => {
    const meta = state({
      p: { pinned: true },
      s: { snoozedUntil: NOW + 1_000, pinned: true },
      d: { settledAt: NOW },
      woke: { snoozedUntil: NOW - 1 },
    });
    const sections = railSections([thread("p"), thread("s"), thread("d"), thread("woke"), thread("a")], meta, NOW);
    expect(ids(sections.pinned)).toEqual(["p"]);
    expect(ids(sections.snoozed)).toEqual(["s"]);
    expect(ids(sections.settled)).toEqual(["d"]);
    expect(ids(sections.active)).toEqual(["woke", "a"]);
  });

  it("orders pins by rank, new threads above arranged ones, snoozes by wake time and the shelf latest first", () => {
    const meta = state({
      p1: { pinned: true, pinOrder: 1 }, p0: { pinned: true, pinOrder: 0 },
      arranged1: { order: 1 }, arranged0: { order: 0 },
      late: { snoozedUntil: NOW + 2_000 }, soon: { snoozedUntil: NOW + 1_000 },
      old: { settledAt: NOW - 10 }, recent: { settledAt: NOW },
    });
    const threads = ["p1", "p0", "arranged1", "arranged0", "late", "soon", "old", "recent"].map((id) => thread(id))
      .concat([thread("newer", NOW + 5), thread("new", NOW + 1)]);
    const sections = railSections(threads, meta, NOW);
    expect(ids(sections.pinned)).toEqual(["p0", "p1"]);
    expect(ids(sections.active)).toEqual(["newer", "new", "arranged0", "arranged1"]);
    expect(ids(sections.snoozed)).toEqual(["soon", "late"]);
    expect(ids(sections.settled)).toEqual(["recent", "old"]);
  });

  it("keeps threads started from one prompt together, where the first of them is", () => {
    const meta = state({ one: { siblingGroupId: "g" }, two: { siblingGroupId: "g" } });
    const sections = railSections([thread("one", 9), thread("other", 8), thread("two", 7)], meta, NOW);
    expect(ids(sections.active)).toEqual(["one", "two", "other"]);
  });
});

describe("dropping a thread", () => {
  const meta = state({ p: { pinned: true, pinOrder: 0 }, s: { snoozedUntil: NOW + 60_000 }, d: { settledAt: 1, settledBy: "user" } });
  const sections = railSections([thread("p"), thread("a", 3), thread("b", 2), thread("s"), thread("d")], meta, NOW);

  it("names what the drop does, and refuses the snoozed shelf", () => {
    expect(dropLabel("active", "pinned")).toBe("Pin");
    expect(dropLabel("pinned", "active")).toBe("Unpin");
    expect(dropLabel("active", "active")).toBe("Move");
    expect(dropLabel("settled", "active")).toBe("Un-settle");
    expect(dropLabel("snoozed", "pinned")).toBe("Wake");
    expect(dropLabel("active", "settled")).toBe("Settle");
    expect(dropLabel("active", "snoozed")).toBeUndefined();
    expect(dropPatches(meta, sections, "a", { sectionId: "snoozed" }, NOW)).toBeUndefined();
  });

  it("pins at the spot it lands and ranks the whole pinned list", () => {
    const next = applyPatches(meta, dropPatches(meta, sections, "a", { sectionId: "pinned", beforeThreadId: "p" }, NOW)!);
    expect(ids(railSections([thread("p"), thread("a", 3), thread("b", 2)], next, NOW).pinned)).toEqual(["a", "p"]);
  });

  it("reorders the active list and makes every thread in it arranged", () => {
    const next = applyPatches(meta, dropPatches(meta, sections, "a", { sectionId: "active" }, NOW)!);
    expect(next.threads.b).toEqual({ order: 0 });
    expect(next.threads.a).toEqual({ order: 1 });
  });

  it("wakes a snoozed thread and un-settles a settled one it moves into the live lists", () => {
    const woken = applyPatches(meta, dropPatches(meta, sections, "s", { sectionId: "active", beforeThreadId: "a" }, NOW)!);
    expect(woken.threads.s).toEqual({ order: 0 });
    const back = applyPatches(meta, dropPatches(meta, sections, "d", { sectionId: "pinned" }, NOW)!);
    expect(back.threads.d).toEqual({ pinned: true, pinOrder: 1, keptAt: NOW });
    const shelved = applyPatches(meta, dropPatches(meta, sections, "p", { sectionId: "settled" }, NOW)!);
    expect(shelved.threads.p).toEqual({ settledAt: NOW, settledBy: "user" });
  });
});

describe("the sweep", () => {
  const quiet = (id: string, days: number, cwd = `/checkouts/${id}`) => ({ id, cwd, modifiedAt: NOW - days * DAY_MS });

  it("wakes snoozes that ran out and knows when the next one does", () => {
    const meta = state({ due: { snoozedUntil: NOW - 1 }, later: { snoozedUntil: NOW + 500 } });
    expect(sweepPatches([], meta, new Set(), new Map(), NOW)).toEqual({ due: { snoozedUntil: null } });
    expect(nextWake(meta, NOW)).toBe(NOW + 500);
    expect(applyPatches(meta, { later: snoozePatch(NOW + 100) }).threads.later).toEqual({ snoozedUntil: NOW + 100 });
  });

  it("settles a thread quiet for longer than the setting allows, and nothing while the setting is off", () => {
    const threads = [quiet("old", 4), quiet("fresh", 1)];
    expect(sweepPatches(threads, state({}), new Set(), new Map(), NOW)).toEqual({});
    const patches = sweepPatches(threads, state({}, { inactiveDays: 3 }), new Set(), new Map(), NOW);
    expect(Object.keys(patches)).toEqual(["old"]);
    expect(patches.old).toMatchObject({ settledAt: NOW, settledBy: "inactive" });
  });

  it("leaves running, snoozed and already settled threads alone, and one the user kept until it moves again", () => {
    const threads = [quiet("running", 9), quiet("snoozed", 9), quiet("settled", 9), quiet("kept", 9), quiet("worked", 9)];
    const meta = state({
      snoozed: { snoozedUntil: NOW + 1 },
      settled: { settledAt: 1, settledBy: "user" },
      kept: { keptAt: NOW - DAY_MS },
      worked: { keptAt: NOW - 20 * DAY_MS, activityAt: NOW - 10 * DAY_MS },
    }, { inactiveDays: 3 });
    expect(Object.keys(sweepPatches(threads, meta, new Set(["running"]), new Map(), NOW))).toEqual(["worked"]);
  });

  it("settles on a merged request by default, on a closed one only when asked, and never twice for the same request", () => {
    const threads = [quiet("merged", 0), quiet("closed", 0), quiet("open", 0)];
    const requests = new Map([
      ["/checkouts/merged", { state: "merged" as const, url: "https://example.test/pr/1" }],
      ["/checkouts/closed", { state: "closed" as const, url: "https://example.test/pr/2" }],
      ["/checkouts/open", { state: "open" as const, url: "https://example.test/pr/3" }],
    ]);
    const defaults = sweepPatches(threads, state({}), new Set(), requests, NOW);
    expect(defaults).toEqual({ merged: { ...settlePatch(NOW, "pr-merged"), settledForRequest: "https://example.test/pr/1" } });
    expect(Object.keys(sweepPatches(threads, state({}, { onClosed: true }), new Set(), requests, NOW))).toEqual(["merged", "closed"]);
    const again = state({ merged: { keptAt: NOW - 5, activityAt: NOW, settledForRequest: "https://example.test/pr/1" } });
    expect(sweepPatches(threads, again, new Set(), requests, NOW)).toEqual({});
  });

  it("counts a thread's linked requests beside its branch's, and waits for the last one", () => {
    const threads = [quiet("linked", 0, "/project"), quiet("mixed", 0, "/worktrees/mixed"), quiet("closed", 0, "/project")];
    const requests = new Map([["/worktrees/mixed", { state: "merged" as const, url: "https://example.test/pr/1" }]]);
    const linked = new Map([
      ["linked", [{ state: "merged" as const, url: "https://example.test/pr/5" }]],
      ["mixed", [{ state: "open" as const, url: "https://example.test/pr/2" }]],
      ["closed", [{ state: "closed" as const, url: "https://example.test/pr/3" }, { url: "https://example.test/pr/4" }]],
    ]);
    expect(sweepPatches(threads, state({}, { onClosed: true }), new Set(), requests, NOW, linked)).toEqual({
      linked: { ...settlePatch(NOW, "pr-merged"), settledForRequest: "https://example.test/pr/5" },
    });
    const allClosed = new Map([["closed", [{ state: "closed" as const, url: "https://example.test/pr/3" }]]]);
    // Without its open link, "mixed" goes by its branch's merged request alone.
    expect(Object.keys(sweepPatches(threads, state({}), new Set(), requests, NOW, allClosed))).toEqual(["mixed"]);
    expect(Object.keys(sweepPatches(threads, state({}, { onClosed: true }), new Set(), requests, NOW, allClosed))).toEqual(["mixed", "closed"]);
    expect(linkedRequestThreads(threads, state({}), new Set(["mixed"]), NOW)).toEqual(["linked", "closed"]);
    expect(linkedRequestThreads(threads, state({}, { onMerged: false }), new Set(), NOW)).toEqual([]);
  });

  it("asks about the request only of a thread that has its checkout to itself", () => {
    const threads = [quiet("a", 0, "/project"), quiet("b", 0, "/project"), quiet("tree", 0, "/worktrees/tree"), quiet("busy", 0, "/worktrees/busy")];
    expect(requestCheckouts(threads, state({}), new Set(["busy"]), NOW)).toEqual(["/worktrees/tree"]);
    expect(requestCheckouts(threads, state({}, { onMerged: false }), new Set(), NOW)).toEqual([]);
  });
});

describe("snooze presets", () => {
  const until = (now: Date, id: string) => snoozePresets(now).find((preset) => preset.id === id)?.until;

  it("offers the snooze presets, in local time", () => {
    const wednesday = new Date(2026, 8, 23, 15, 30);
    expect(snoozePresets(wednesday).map((preset) => preset.label)).toEqual(["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"]);
    expect(until(wednesday, "snooze:1h")! - wednesday.getTime()).toBe(60 * 60 * 1_000);
    expect(until(wednesday, "snooze:3h")! - wednesday.getTime()).toBe(3 * 60 * 60 * 1_000);
    expect(new Date(until(wednesday, "snooze:evening")!)).toEqual(new Date(2026, 8, 23, 18, 0));
    expect(new Date(until(wednesday, "snooze:tomorrow")!)).toEqual(new Date(2026, 8, 24, 9, 0));
    expect(new Date(until(wednesday, "snooze:next-week")!)).toEqual(new Date(2026, 8, 28, 9, 0));
    expect(new Date(until(new Date(2026, 8, 28, 8, 0), "snooze:next-week")!)).toEqual(new Date(2026, 9, 5, 9, 0));
  });

  it("drops the evening within its last hour and next week when that is tomorrow", () => {
    expect(until(new Date(2026, 8, 23, 17, 30), "snooze:evening")).toBeUndefined();
    const sunday = new Date(2026, 8, 27, 12, 0);
    expect(until(sunday, "snooze:next-week")).toBeUndefined();
    expect(new Date(until(sunday, "snooze:tomorrow")!)).toEqual(new Date(2026, 8, 28, 9, 0));
  });
});

describe("archive and undo", () => {
  it("takes an archived thread out of every section it held, and puts it back where it was", () => {
    const meta = applyPatches(state({ p: { pinned: true, pinOrder: 0 }, d: { settledAt: 1, archivedAt: NOW - 5 } }), { p: archivePatch(NOW) });
    const sections = railSections([thread("p"), thread("d"), thread("a")], meta, NOW);
    expect(ids(sections.pinned)).toEqual([]);
    expect(ids(sections.settled)).toEqual([]);
    expect(ids(sections.archived)).toEqual(["p", "d"]);
    const back = railSections([thread("p"), thread("d")], applyPatches(meta, { p: { archivedAt: null } }), NOW);
    expect(ids(back.pinned)).toEqual(["p"]);
    expect(decodeState({ threads: { x: { archivedAt: 3 } } }).threads.x).toEqual({ archivedAt: 3 });
  });

  it("never settles an archived thread by a rule", () => {
    const patches = sweepPatches([{ id: "old", cwd: "/old", modifiedAt: NOW - 9 * DAY_MS }], state({ old: { archivedAt: NOW - DAY_MS } }, { inactiveDays: 1 }), new Set(), new Map(), NOW);
    expect(patches).toEqual({});
  });

  it("inverts a patch to the fields as they were", () => {
    const before: ThreadMeta = { pinned: true, pinOrder: 2, snoozedUntil: NOW + 5 };
    const patch = settlePatch(NOW, "user");
    const after = applyPatches(state({ t: before }), { t: patch });
    expect(applyPatches(after, { t: inversePatch(before, patch) }).threads.t).toEqual(before);
    expect(inversePatch(undefined, { archivedAt: NOW })).toEqual({ archivedAt: null });
  });

  it("falls back to the newest other thread of the same project, then to any other", () => {
    const other = (id: string, projectPath: string, modifiedAt: number) => ({ ...thread(id, modifiedAt), projectPath });
    const leaving = other("x", "/one", 5);
    expect(fallbackThread([other("far", "/two", 9), leaving, other("old", "/one", 1), other("new", "/one", 3)], leaving)?.id).toBe("new");
    expect(fallbackThread([other("far", "/two", 9), leaving], leaving)?.id).toBe("far");
    expect(fallbackThread([leaving], leaving)).toBeUndefined();
  });

  it("moves past a parked thread to the next one that stays, wrapping round to the top", () => {
    const order = ["p", "a", "b", "c", "d"];
    const all = () => true;
    expect(nextActiveThread(order, "b", all)).toBe("c");
    expect(nextActiveThread(order, "d", all)).toBe("p");
    // Threads parked in the same batch are skipped.
    expect(nextActiveThread(order, "b", (id) => !["c", "d"].includes(id))).toBe("p");
    expect(nextActiveThread(order, "b", (id) => id === "a")).toBe("a");
    expect(nextActiveThread(["b"], "b", all)).toBeUndefined();
    expect(nextActiveThread(order, "b", () => false)).toBeUndefined();
    // A thread the list does not show has no next one.
    expect(nextActiveThread(order, "x", all)).toBeUndefined();
  });
});


describe("working section", () => {
  it("is opt-in, preserves parking precedence and returns to the saved order after completion", () => {
    const threads = ["a", "b", "pin", "snooze", "settled", "archive"].map((id) => thread(id));
    const saved = state({ a: { order: 2 }, b: { order: 1 }, pin: { pinned: true }, snooze: { snoozedUntil: NOW + 100 }, settled: { settledAt: NOW }, archive: { archivedAt: NOW } });
    const running = new Set(threads.map((entry) => entry.id));
    expect(ids(railSections(threads, saved, NOW, running).working)).toEqual([]);
    const opted = { ...saved, settings: { ...saved.settings, workingSection: true } };
    const during = railSections(threads, opted, NOW, running);
    expect(ids(during.working)).toEqual(["b", "a"]);
    expect(ids(during.pinned)).toEqual(["pin"]);
    expect(ids(during.snoozed)).toEqual(["snooze"]);
    expect(ids(during.settled)).toEqual(["settled"]);
    expect(ids(during.archived)).toEqual(["archive"]);
    expect(ids(railSections(threads, opted, NOW).active)).toEqual(["b", "a"]);
    expect(decodeState(JSON.parse(JSON.stringify(opted)))).toEqual(opted);
  });

  it("keeps runtime failures and interrupted or limited turns in attention even with stale running marks", () => {
    const threads = [ { ...thread("error"), turnError: "failed" }, { ...thread("runtime"), runtimeError: "offline" }, { ...thread("interrupted"), interrupted: true } ];
    const sections = railSections(threads, state({}, { workingSection: true }), NOW, new Set(threads.map((entry) => entry.id)));
    expect(sections.working).toEqual([]);
    expect(ids(sections.active)).toEqual(["error", "runtime", "interrupted"]);
  });
});


it("keeps working ranks when an attention row is manually reordered", () => {
  const threads = [thread("a"), thread("busy"), thread("b")];
  const initial = state({ a: { order: 0 }, busy: { order: 1 }, b: { order: 2 } }, { workingSection: true });
  const sections = railSections(threads, initial, NOW, new Set(["busy"]));
  const patches = dropPatches(initial, sections, "b", { sectionId: "active", beforeThreadId: "a" }, NOW)!;
  const reordered = applyPatches(initial, patches);
  expect(ids(railSections(threads, reordered, NOW).active)).toEqual(["b", "a", "busy"]);
});
