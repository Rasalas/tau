import { describe, expect, it, vi } from "vitest";
import { ThreadUndo } from "./undo.js";

function setup() {
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const errors: string[] = [];
  const undo = new ThreadUndo({
    schedule: (run) => {
      const timer = { run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    onError: (action, error) => errors.push(`${action}: ${String(error)}`),
  });
  /** Fires the window the last action opened, the way the clock would. */
  const expire = () => { const timer = timers.at(-1)!; if (!timer.cancelled) timer.run(); };
  return { undo, expire, errors, timers };
}

describe("ThreadUndo", () => {
  it("shows consecutive actions of one kind as one notice and takes them back together", () => {
    const { undo } = setup();
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const c = vi.fn(async () => undefined);
    undo.record("pin", "x", "Unpinned", c);
    undo.record("archive", "a", "Archived", a);
    undo.record("archive", "b", "Archived", b);
    expect(undo.getNotice()).toEqual({ action: "Archived", count: 2 });

    expect(undo.undo()).toBe(true);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(c).not.toHaveBeenCalled();
    // The older group is next, while the window is still open.
    expect(undo.getNotice()).toEqual({ action: "Unpinned", count: 1 });
  });

  it("forgets everything when the window closes, and a second press takes nothing twice", () => {
    const { undo, expire } = setup();
    const run = vi.fn(async () => undefined);
    undo.record("settle", "a", "Settled", run);
    expect(undo.undo()).toBe(true);
    expect(undo.undo()).toBe(false);
    expect(run).toHaveBeenCalledOnce();

    undo.record("snooze", "b", "Snoozed", run);
    expire();
    expect(undo.getNotice()).toBeUndefined();
    expect(undo.undo()).toBe(false);
  });

  it("restarts the window with every action", () => {
    const { undo, timers } = setup();
    undo.record("pin", "a", "Unpinned", async () => undefined);
    undo.record("pin", "b", "Unpinned", async () => undefined);
    expect(timers.map((timer) => timer.cancelled)).toEqual([true, false]);
  });

  it("lets a later action of the same kind, the opposite action and a settle spend an earlier undo", () => {
    const { undo } = setup();
    const first = vi.fn(async () => undefined);
    undo.record("snooze", "a", "Snoozed", first);
    undo.record("snooze", "a", "Snoozed", async () => undefined);
    expect(undo.getNotice()).toEqual({ action: "Snoozed", count: 1 });

    undo.record("pin", "a", "Unpinned", async () => undefined);
    undo.record("settle", "a", "Settled", async () => undefined);
    expect(undo.getNotice()).toEqual({ action: "Settled", count: 1 });
    undo.invalidate("settle", "a");
    expect(undo.getNotice()).toBeUndefined();
    expect(first).not.toHaveBeenCalled();
  });

  it("reports an undo that failed", async () => {
    const { undo, errors } = setup();
    undo.record("delete", "a", "Deleted", async () => { throw new Error("gone"); });
    undo.undo();
    await vi.waitFor(() => expect(errors).toEqual(["Deleted: Error: gone"]));
  });
});
