// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UsageActivity, QuotaHistory, calendarDays } from "./activity.js";
import { UsageLimits } from "./limits.js";
import { emptyTotals } from "./aggregate.js";
import type { UsageLimitAccount, UsageRow, UsageSummary } from "./protocol.js";

afterEach(cleanup);
const now = new Date(2026, 8, 22, 15).getTime();
const row: UsageRow = { day: "2026-09-22", backend: "codex", backendLabel: "Codex", cwd: "/a", projectName: "a", model: "m", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: .2, apiValueUsd: .5, requests: 3, threads: 1 };
const summary: UsageSummary = { scannedAt: now, rows: [row, { ...row, backend: "pi", backendLabel: "Pi", requests: 7 }], totals: emptyTotals(), sources: [] };
const account: UsageLimitAccount = { id: "a", runtime: "codex", label: "Codex", checkedAt: now, windows: [{ id: "w", label: "5-hour", kind: "session", usedPercent: 90, resetsAt: now + 60_000, windowMinutes: 300 }] };

describe("activity views", () => {
  it("builds calendar dates across month boundaries", () => {
    expect(calendarDays(new Date(2026, 2, 2), 3)).toEqual(["2026-02-28", "2026-03-01", "2026-03-02"]);
  });
  it("filters recorded daily activity and switches metrics without mixing billed and plan value", () => {
    render(<UsageActivity summary={summary} now={now} period="7d" />);
    fireEvent.click(screen.getByRole("button", { name: /Sep 22: 10 responses · Codex: 3 · Pi: 7/u }));
    expect(screen.getByText("Sep 22: 10 responses · Codex: 3 · Pi: 7")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Activity runtime" })).getByText("Codex"));
    expect(screen.getByRole("button", { name: "Sep 22: 3 responses · Codex: 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "API billed" }));
    expect(within(screen.getByRole("group", { name: "Daily activity" })).getByRole("button", { name: "Sep 22: $0.20" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan value" }));
    expect(within(screen.getByRole("group", { name: "Daily activity" })).getByRole("button", { name: "Sep 22: $0.50" })).toBeTruthy();
  });
  it("does not connect quota readings across resets or measurement gaps", () => {
    const history = [now - 30 * 60_000, now - 25 * 60_000, now - 5 * 60_000, now].map((checkedAt, i) => ({ source: "codex", account: { ...account, checkedAt, windows: [{ ...account.windows[0]!, resetsAt: i === 3 ? now + 2 * 60_000 : now + 60_000 }] } }));
    const { container } = render(<QuotaHistory now={now} limits={{ checkedAt: now, accounts: [account], sources: [], history }} />);
    const path = container.querySelector(".usage-history-line")!.getAttribute("d")!;
    expect(path.match(/M/gu)).toHaveLength(3);
    expect(path.match(/H/gu)).toHaveLength(1);
  });
});

describe("quota cards", () => {
  it("removes expired percentages and fill, retaining the reset explanation", () => {
    const { container } = render(<UsageLimits now={now + 60_000} limits={{ checkedAt: now, accounts: [account], sources: [] }} error={undefined} rows={[]} periodLabel="7 days" />);
    expect(screen.getByText("Waiting for a new reading")).toBeTruthy();
    expect(screen.queryByText("90% used")).toBeNull();
    expect(container.querySelector(".usage-window-fill")).toBeNull();
    expect(container.querySelector(".usage-window-time")).toBeNull();
  });
  it("keeps last known values visible after a failed refresh without a live status", () => {
    render(<UsageLimits now={now} limits={{ checkedAt: now, accounts: [account], sources: [] }} error="Provider unavailable" rows={[]} periodLabel="7 days" />);
    expect(screen.getByText("90% used")).toBeTruthy();
    expect(screen.getAllByText("Last known reading").length).toBeGreaterThan(0);
    expect(screen.queryByText("Live reading")).toBeNull();
  });
});
