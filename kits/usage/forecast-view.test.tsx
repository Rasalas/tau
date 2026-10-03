// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { dayStarts } from "./dashboard.js";
import { UsageForecast } from "./forecast-view.js";
import type { UsageEntry } from "./protocol.js";

afterEach(cleanup);
const now = new Date(2026, 9, 3, 16);
const days = dayStarts(90, now);
const entry = (fields: Partial<UsageEntry> = {}): UsageEntry => ({ day: 88, backend: "opencode", provider: "openrouter", threadId: "t", cwd: "/work", model: "m", requests: 1,
  inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000, costUsd: 0, apiValueUsd: 0, ...fields });

describe("Usage monthly forecast", () => {
  it("defaults to seven days, switches to thirty, and separates the zero bill from free usage's API value", () => {
    render(<UsageForecast entries={[entry({ billing: "free", apiEquivalentUsd: 7 }), entry({ day: 74, billing: "free", apiEquivalentUsd: 53 })]} days={days} now={now} />);
    const section = within(screen.getByRole("region", { name: "Monthly forecast" }));
    expect(section.getByRole("button", { name: "Last 7 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(section.getByText("≈ $31.00")).toBeTruthy();
    expect(section.getByText("$0.00 API spend")).toBeTruthy();
    expect(section.getByText("≈ $7.00")).toBeTruthy();
    fireEvent.click(section.getByRole("button", { name: "Last 30 days" }));
    expect(section.getByRole("button", { name: "Last 30 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(section.getByText("≈ $62.00")).toBeTruthy();
    expect(section.getByText(/Average of the last 30 completed calendar days/u)).toBeTruthy();
  });

  it("labels incomplete estimates and does not claim an unknown model costs zero", () => {
    render(<UsageForecast entries={[entry(), entry({ provider: "anthropic", costUsd: 7 }), entry({ provider: "anthropic" })]} days={days} now={now} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("≥ $31.00")).toBeTruthy();
    expect(within(rows[1]!).getAllByText("Unknown")).toHaveLength(3);
    expect(within(rows[1]!).getByText("1.0k tok without a price in the average")).toBeTruthy();
  });
});
