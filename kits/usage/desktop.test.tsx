// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import usageExtension from "./desktop.js";
import { UsagePage } from "./page.js";
import { USAGE_SETTINGS_PAGE, type UsageRow, type UsageSummary } from "./protocol.js";
import { groupRows, periodStart } from "./view-model.js";

afterEach(cleanup);

const NOW = new Date(2026, 8, 22, 15, 30);

function row(overrides: Partial<UsageRow>): UsageRow {
  return {
    backend: "pi", backendLabel: "Pi", cwd: "/work/alpha", projectName: "alpha", model: "anthropic/claude-haiku-4-5",
    requests: 1, inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100, costUsd: 0.01, threads: 1,
    ...overrides,
  };
}

const rows = [
  row({}),
  row({ model: "openai/gpt-5.6-luna", costUsd: 0, requests: 2, totalTokens: 500 }),
  row({ backend: "claude-code", backendLabel: "Claude Code", model: "haiku", costUsd: 0.5, requests: 3 }),
  row({ cwd: "/work/beta", projectName: "beta", costUsd: 0.2 }),
];

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    scannedAt: NOW.getTime(),
    totals: { requests: 7, inputTokens: 4_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3_800, costUsd: 0.71, threads: 3 },
    rows,
    sources: [
      { backend: "pi", label: "Pi", status: "ok", detail: "Read 4 session files in /sessions.", dating: "message" },
      { backend: "antigravity", label: "Antigravity", status: "unavailable", detail: "Not available: Host extension tau.antigravity is not installed.", dating: "thread" },
    ],
    ...overrides,
  };
}

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({ invoke, onEvent: () => () => undefined });

describe("periods and groups", () => {
  it("starts a period at local midnight", () => {
    expect(periodStart("all", NOW)).toBeUndefined();
    expect(periodStart("today", NOW)).toBe(new Date(2026, 8, 22).getTime());
    expect(periodStart("7d", NOW)).toBe(new Date(2026, 8, 16).getTime());
    expect(periodStart("30d", NOW)).toBe(new Date(2026, 7, 24).getTime());
  });

  it("groups rows by project, runtime or model, most expensive first", () => {
    expect(groupRows(rows, "project").map((group) => [group.label, group.requests, group.threads])).toEqual([["alpha", 6, undefined], ["beta", 1, undefined]]);
    expect(groupRows(rows, "backend").map((group) => group.label)).toEqual(["Claude Code", "Pi"]);
    expect(groupRows(rows, "model").map((group) => group.label)).toEqual(["haiku", "anthropic/claude-haiku-4-5", "openai/gpt-5.6-luna"]);
    expect(groupRows(rows, "all")).toHaveLength(4);
  });
});

describe("Usage page", () => {
  it("shows the totals, the table and the sources, and asks for the period the user picks", async () => {
    const invoke = vi.fn(async () => summary());
    render(<UsagePage cwd="/work/alpha" onNotify={vi.fn()} host={host(invoke)} now={() => NOW} />);

    const totals = await screen.findByLabelText("Totals");
    expect(within(totals).getByText("$0.71")).toBeTruthy();
    expect(within(totals).getByText("3.8k")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("summary", { since: new Date(2026, 8, 16).getTime() });

    const table = screen.getByRole("table", { name: "Usage" });
    expect(within(table).getAllByRole("row").map((line) => line.querySelector("strong")?.textContent).filter(Boolean)).toEqual(["alpha", "beta"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Group by" })).getByText("Runtime"));
    expect(within(screen.getByRole("table", { name: "Usage" })).getByText("Claude Code")).toBeTruthy();

    const sources = screen.getByLabelText("Sources");
    expect(within(sources).getByText("not available")).toBeTruthy();
    expect(within(sources).getByText(/tau\.antigravity is not installed/u)).toBeTruthy();

    fireEvent.click(within(screen.getByRole("group", { name: "Period" })).getByText("All time"));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("summary", {}));
    fireEvent.click(screen.getByText("Read again"));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("summary", { refresh: true }));
  });

  it("explains where the numbers would come from when a period has none", async () => {
    const invoke = vi.fn(async () => summary({ rows: [], totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0 } }));
    render(<UsagePage onNotify={vi.fn()} host={host(invoke)} now={() => NOW} />);
    expect(await screen.findByText(/Nothing was recorded in this period/u)).toBeTruthy();
    expect(screen.getByText("no priced model in this period")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Usage" })).toBeNull();
  });

  it("says so when the host half cannot answer", async () => {
    render(<UsagePage onNotify={vi.fn()} host={host(async () => { throw new Error("Host extension Usage is not active."); })} />);
    expect(await screen.findByText("Host extension Usage is not active.")).toBeTruthy();
  });
});

describe("Usage kit", () => {
  it("contributes the Settings page its command opens, and takes both back", () => {
    const { registry } = createKitHarness(vi.fn(async () => summary()));
    registry.activate(usageExtension);
    expect(registry.getSettingsPages().map((page) => page.id)).toEqual([USAGE_SETTINGS_PAGE]);
    const openSettings = vi.fn();
    void registry.getCommands().find((command) => command.id === "usage.open")?.run({ openSettings } as unknown as WorkbenchActions);
    expect(openSettings).toHaveBeenCalledWith(USAGE_SETTINGS_PAGE);
    registry.deactivate(usageExtension.id);
    expect(registry.getSettingsPages()).toEqual([]);
    expect(registry.getCommands().filter((command) => command.id === "usage.open")).toEqual([]);
  });
});
