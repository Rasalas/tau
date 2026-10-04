import { describe, expect, it, vi } from "vitest";
import type { UiReviewRequest } from "tau";
import { checksLabel, RowRequests } from "./requests.js";

const REQUEST: UiReviewRequest = { provider: "github", number: 3, title: "T", url: "https://example.com/3", baseRef: "main", state: "open" };

describe("rail request cache", () => {
  it("discards a queued refresh when the window's cache is disposed", async () => {
    let finish!: (request: UiReviewRequest) => void;
    const load = vi.fn(() => new Promise<UiReviewRequest>((resolve) => { finish = resolve; }));
    const rows = new RowRequests(load);
    rows.ensure("ws-a");
    rows.ensure("ws-a", true);
    rows.dispose();
    finish(REQUEST);
    await vi.waitFor(() => expect(rows.get("ws-a")).toEqual(REQUEST));
    expect(load).toHaveBeenCalledOnce();
  });
  it("retains the known lifecycle state after a transient refresh failure", async () => {
    const load = vi.fn().mockResolvedValueOnce({ ...REQUEST, state: "merged" }).mockRejectedValueOnce(new Error("offline"));
    const rows = new RowRequests(load);
    rows.ensure("ws-a");
    await vi.waitFor(() => expect(rows.get("ws-a")?.state).toBe("merged"));
    rows.ensure("ws-a", true);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(rows.get("ws-a")?.state).toBe("merged");
    expect(load).toHaveBeenLastCalledWith("ws-a", true);
  });
  it("rereads a checkout whose branch changes during an outstanding request", async () => {
    let finish!: (request: UiReviewRequest) => void;
    const next = { ...REQUEST, number: 4, headRef: "new-branch" };
    const load = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(next);
    const rows = new RowRequests(load, () => 0);
    rows.ensure("ws-a");
    rows.ensure("ws-a", true);
    rows.ensure("ws-a", true);
    expect(load).toHaveBeenCalledTimes(1);
    finish(REQUEST);
    await vi.waitFor(() => expect(rows.get("ws-a")).toEqual(next));
    expect(load).toHaveBeenCalledTimes(2);
    rows.ensure("ws-a");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks once per checkout and minute, however many rows share it", async () => {
    let clock = 0;
    const load = vi.fn(async () => REQUEST);
    const rows = new RowRequests(load, () => clock);
    const changed = vi.fn();
    rows.subscribe(changed);
    rows.ensure("/a");
    rows.ensure("/a");
    await vi.waitFor(() => expect(rows.get("/a")).toEqual(REQUEST));
    rows.ensure("/a");
    expect(load).toHaveBeenCalledTimes(1);
    clock += 61_000;
    rows.ensure("/a");
    expect(load).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalled();
  });

  it("counts open requests once, however many checkouts share one", () => {
    const rows = new RowRequests(async () => undefined, () => 0);
    expect(rows.openCount()).toBe(0);
    rows.set("/a", REQUEST);
    rows.set("/a-worktree", REQUEST);
    rows.set("/b", { ...REQUEST, number: 4, url: "https://example.com/4" });
    rows.set("/c", { ...REQUEST, number: 5, url: "https://example.com/5", state: "merged" });
    rows.set("/d", undefined);
    expect(rows.openCount()).toBe(2);
  });

  it("remembers a failed lookup as no request until the minute is over", async () => {
    const load = vi.fn(async () => { throw new Error("gh failed"); });
    const rows = new RowRequests(load, () => 0);
    rows.ensure("/a");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rows.ensure("/a");
    expect(rows.get("/a")).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("words checks by the worst news first", () => {
    expect(checksLabel({ passed: 1, failed: 1, pending: 1, total: 3 })).toBe("1 failing");
    expect(checksLabel({ passed: 1, failed: 0, pending: 2, total: 3 })).toBe("2 pending");
    expect(checksLabel({ passed: 3, failed: 0, pending: 0, total: 3 })).toBe("3/3 passed");
    expect(checksLabel(undefined)).toBeUndefined();
  });
});
