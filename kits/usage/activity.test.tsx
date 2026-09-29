// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityCalendar, activityLevel, ReadingHistory } from "./activity.js";
import { dayStarts } from "./dashboard.js";
import type { UsageEntry, UsageLimitAccount, UsageLimitsSummary } from "./protocol.js";

afterEach(cleanup);

const now = new Date(2026, 8, 22, 15).getTime();
const entry: UsageEntry = { day: 13, backend: "codex", threadId: "t", cwd: "/a", model: "m", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.2, apiValueUsd: 0.5, requests: 3 };

describe("the activity calendar", () => {
  it("shades a day by its turns on a log scale against the busiest", () => {
    expect([0, 1, 10, 100].map((turns) => activityLevel(turns, 100))).toEqual([0, 1, 3, 4]);
  });

  it("puts each day in its weekday row and week column, and names its turns per runtime", () => {
    // 22 Sep 2026 is a Tuesday: the first of 14 days, 9 Sep, is a Wednesday.
    const days = dayStarts(14, new Date(now));
    const { container } = render(<ActivityCalendar days={days} entries={[entry, { ...entry, backend: "pi", requests: 7 }, { ...entry, day: 0, requests: 1 }]} labels={{ codex: "Codex", pi: "Pi" }} />);
    expect(screen.getByRole("img", { name: "2 of the last 14 days with turns" })).toBeTruthy();
    const cells = [...container.querySelectorAll<HTMLElement>(".usage-calendar-grid > i")];
    expect(cells).toHaveLength(14);
    expect([cells[0]!.style.gridColumn, cells[0]!.style.gridRow]).toEqual(["2", "4"]);
    expect([cells[13]!.style.gridColumn, cells[13]!.style.gridRow]).toEqual(["4", "3"]);
    expect([cells[0]!.dataset.level, cells[1]!.dataset.level, cells[13]!.dataset.level]).toEqual(["2", "0", "4"]);
    expect(cells[13]!.dataset.tooltip).toMatch(/: 10 turns \(Pi 7, Codex 3\)$/u);
    expect(cells[1]!.dataset.tooltip).toMatch(/: nothing recorded$/u);
  });
});

describe("the readings of the last day", () => {
  const account: UsageLimitAccount = { id: "a", runtime: "codex", label: "Codex", checkedAt: now, windows: [{ id: "w", label: "5-hour", kind: "session", usedPercent: 90, resetsAt: now + 60_000, windowMinutes: 300 }] };

  it("never joins readings across a reset, a gap or a drop", () => {
    const history = [now - 30 * 60_000, now - 25 * 60_000, now - 5 * 60_000, now].map((checkedAt, index) => ({
      source: "tau.codex",
      account: { ...account, checkedAt, windows: [{ ...account.windows[0]!, resetsAt: index === 3 ? now + 5 * 60 * 60_000 : now + 60_000 }] },
    }));
    const limits: UsageLimitsSummary = { checkedAt: now, accounts: [account], sources: [], history };
    const { container } = render(<ReadingHistory now={now} limits={limits} />);
    const path = container.querySelector(".usage-readings-line")!.getAttribute("d")!;
    expect(path.match(/M/gu)).toHaveLength(3);
    expect(path.match(/H/gu)).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Codex · 5-hour: 4 readings, last 10% left" })).toBeTruthy();
  });

  it("says how the history fills when nothing was kept", () => {
    render(<ReadingHistory now={now} limits={{ checkedAt: now, accounts: [account], sources: [], history: [] }} />);
    expect(screen.getByText(/Each read of the limits adds a point here/u)).toBeTruthy();
  });
});
