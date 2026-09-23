// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TauConfig, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider, createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import usageExtension from "./desktop.js";
import { UsagePage } from "./page.js";
import { priceFromDraft } from "./prices.js";
import { USAGE_SETTINGS_PAGE, type UsageLimitsSummary, type UsageRow, type UsageSummary } from "./protocol.js";
import { groupRows, periodStart, planUsageOf, resetsIn } from "./view-model.js";

afterEach(cleanup);

const NOW = new Date(2026, 8, 22, 15, 30);

function row(overrides: Partial<UsageRow>): UsageRow {
  return {
    backend: "pi", backendLabel: "Pi", cwd: "/work/alpha", projectName: "alpha", model: "anthropic/claude-haiku-4-5",
    requests: 1, inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100, costUsd: 0.01, apiValueUsd: 0, threads: 1,
    ...overrides,
  };
}

const rows = [
  row({}),
  row({ model: "openai-codex/gpt-5.6-luna", provider: "openai-codex", modelId: "gpt-5.6-luna", billing: "subscription", costUsd: 0, apiValueUsd: 1.4, requests: 2, totalTokens: 500 }),
  row({ backend: "claude-code", backendLabel: "Claude Code", model: "haiku", costUsd: 0.5, requests: 3 }),
  row({ cwd: "/work/beta", projectName: "beta", costUsd: 0.2 }),
];

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    scannedAt: NOW.getTime(),
    totals: {
      requests: 7, inputTokens: 4_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3_800, costUsd: 0.71, threads: 3,
      subscription: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 500, requests: 2, apiValueUsd: 1.4 },
    },
    rows,
    sources: [
      { backend: "pi", label: "Pi", status: "ok", detail: "Read 4 session files in /sessions.", dating: "message" },
      { backend: "antigravity", label: "Antigravity", status: "unavailable", detail: "Not available: Host extension tau.antigravity is not installed.", dating: "thread" },
    ],
    ...overrides,
  };
}

const limits: UsageLimitsSummary = {
  checkedAt: NOW.getTime(),
  accounts: [
    { id: "codex:account", runtime: "codex", label: "Codex", plan: "pro", checkedAt: NOW.getTime() - 120_000, windows: [
      { id: "primary", kind: "session", label: "5-hour", usedPercent: 34, windowMinutes: 300, resetsAt: NOW.getTime() + 90 * 60_000 },
      { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 95, windowMinutes: 10_080, resetsAt: NOW.getTime() + 3 * 24 * 3_600_000 },
    ] },
    { id: "pi:openai-codex", runtime: "pi", label: "Pi · openai-codex", checkedAt: NOW.getTime(), windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 10 }] },
    { id: "claude-code:account", runtime: "claude-code", label: "Claude Code", checkedAt: NOW.getTime(), windows: [], unavailable: { reason: "unsupported", message: "An API key or a cloud provider has no plan limits." } },
  ],
  sources: [{ extensionId: "tau.codex", label: "Codex", status: "ok", detail: "1 account, 2 windows." }],
};

/** Answers the page's two commands: the usage summary and the limits. */
const answers = (usage: () => UsageSummary = summary) => vi.fn(async (command: string) => command === "limits" ? limits : usage());

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({ invoke, onEvent: () => () => undefined });

function renderPage(invoke: (command: string, input?: unknown) => Promise<unknown>, config: { host: TauConfig; updates: Array<Partial<TauConfig>>; cleared: string[][] } = { host: {}, updates: [], cleared: [] }) {
  const client = createFakeHostClient({
    getConfigLayers: async () => ({ host: config.host }),
    updateConfig: async (patch: Partial<TauConfig>) => { config.updates.push(patch); config.host = { ...config.host, modelPrices: { ...config.host.modelPrices, ...patch.modelPrices } }; return config.host; },
    clearConfig: async (keys: string[]) => { config.cleared.push(keys); return { host: config.host }; },
  });
  return render(<TestProviders><HostClientProvider client={client}><UsagePage cwd="/work/alpha" onNotify={vi.fn()} host={host(invoke)} now={() => NOW} /></HostClientProvider></TestProviders>);
}

describe("periods and groups", () => {
  it("starts a period at local midnight", () => {
    expect(periodStart("all", NOW)).toBeUndefined();
    expect(periodStart("today", NOW)).toBe(new Date(2026, 8, 22).getTime());
    expect(periodStart("7d", NOW)).toBe(new Date(2026, 8, 16).getTime());
    expect(periodStart("30d", NOW)).toBe(new Date(2026, 7, 24).getTime());
  });

  it("groups rows by project, runtime or model, the largest figure first, a plan's value apart from the money", () => {
    expect(groupRows(rows, "project").map((group) => [group.label, group.requests, group.threads])).toEqual([["alpha", 6, undefined], ["beta", 1, undefined]]);
    expect(groupRows(rows, "backend").map((group) => [group.label, Math.round(group.costUsd * 100), Math.round(group.apiValueUsd * 100)])).toEqual([["Pi", 21, 140], ["Claude Code", 50, 0]]);
    expect(groupRows(rows, "model").map((group) => group.label)).toEqual(["openai-codex/gpt-5.6-luna", "haiku", "anthropic/claude-haiku-4-5"]);
    expect(groupRows(rows, "all")).toHaveLength(4);
  });

  it("finds what an account's plan covered, and counts down to a reset", () => {
    expect(planUsageOf(rows, { runtime: "pi", id: "pi:openai-codex" })).toEqual({ tokens: 500, requests: 2, apiValueUsd: 1.4 });
    expect(planUsageOf(rows, { runtime: "pi", id: "pi:anthropic" })).toEqual({ tokens: 0, requests: 0, apiValueUsd: 0 });
    expect(resetsIn({ resetsAt: 10 + 2 * 3_600_000 + 13 * 60_000 }, 10)).toBe("resets in 2h 13m");
    expect(resetsIn({ resetsAt: 5 }, 10)).toBe("reset");
  });

  it("reads a price from the editor's fields, a blank cache rate being the input rate", () => {
    expect(priceFromDraft({ input: "1", output: "4.4", cacheRead: "" })).toEqual({ input: 1, output: 4.4 });
    expect(priceFromDraft({ input: "1", output: "x" })).toBe("Output must be a number of dollars, 0 or more.");
    expect(priceFromDraft({ output: "2" }, { input: 1, output: 4 })).toEqual({ input: 1, output: 2 });
    expect(priceFromDraft({ input: "1" })).toBe("Enter an input and an output price.");
  });
});

describe("Usage page", () => {
  it("shows the totals, the table and the sources, and asks for the period the user picks", async () => {
    const invoke = answers();
    renderPage(invoke);

    const totals = await screen.findByLabelText("Totals");
    // Money billed and a plan's API value are two tiles, never one sum.
    expect(within(totals).getByText("$0.71")).toBeTruthy();
    expect(within(totals).getByText("≈ $1.40")).toBeTruthy();
    expect(within(totals).getByText(/would have cost via the API/u)).toBeTruthy();
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("summary", { refresh: true }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("limits", { refresh: true }));
  });

  it("shows each plan's windows with what is left and when it resets, and beside them what its usage would have cost via the API", async () => {
    renderPage(answers());
    const codex = await screen.findByRole("region", { name: "Codex limits" });
    expect(within(codex).getByText("pro")).toBeTruthy();
    expect(within(codex).getByText("66% left")).toBeTruthy();
    expect(within(codex).getByText("resets in 1h 30m")).toBeTruthy();
    expect(within(codex).getByRole("img", { name: /Weekly: 5% left, \d+% of the window left, resets in 3d/u })).toBeTruthy();
    const pi = screen.getByRole("region", { name: "Pi · openai-codex limits" });
    await waitFor(() => expect(within(pi).getByText(/7 days on the plan: 500 tokens in 2 turns/u)).toBeTruthy());
    expect(within(pi).getByText("≈ $1.40")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Accounts without limits" })).getByText("An API key or a cloud provider has no plan limits.")).toBeTruthy();
    expect(within(screen.getByLabelText("Sources")).getByText("Codex limits")).toBeTruthy();
  });

  it("explains where the numbers would come from when a period has none", async () => {
    const empty = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0, subscription: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0, apiValueUsd: 0 } };
    renderPage(answers(() => summary({ rows: [], totals: empty })));
    expect(await screen.findByText(/Nothing was recorded in this period/u)).toBeTruthy();
    expect(screen.getByText("nothing billed per token in this period")).toBeTruthy();
    expect(screen.getByText("no plan usage in this period")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Usage" })).toBeNull();
  });

  it("adds, edits and resets the user's own model prices in Tau's config", async () => {
    const config = { host: { modelPrices: { "openai/o4-mini": { input: 1.1, output: 4.4 } } } as TauConfig, updates: [] as Array<Partial<TauConfig>>, cleared: [] as string[][] };
    renderPage(answers(), config);
    const table = await screen.findByRole("table", { name: "Your model prices" });
    await waitFor(() => expect(within(table).getByText("openai/o4-mini")).toBeTruthy());
    fireEvent.change(within(table).getByLabelText("Output price of openai/o4-mini"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(config.updates.at(-1)).toEqual({ modelPrices: { "openai/o4-mini": { input: 1.1, output: 4 } } }));

    const add = screen.getByRole("group", { name: "Add a model price" });
    fireEvent.change(within(add).getByLabelText("Model id"), { target: { value: "gpt-5.6-luna" } });
    fireEvent.change(within(add).getByLabelText("Input price"), { target: { value: "0.2" } });
    fireEvent.change(within(add).getByLabelText("Output price"), { target: { value: "1.2" } });
    fireEvent.click(within(add).getByRole("button", { name: "Add price" }));
    await waitFor(() => expect(config.updates.at(-1)?.modelPrices?.["gpt-5.6-luna"]).toEqual({ input: 0.2, output: 1.2 }));

    fireEvent.click(within(screen.getByRole("table", { name: "Your model prices" })).getAllByRole("button", { name: "Reset to automatic" })[0]!);
    await waitFor(() => expect(config.cleared.at(-1)).toEqual(["modelPrices.gpt-5.6-luna"]));
  });

  it("says so when the host half cannot answer", async () => {
    render(<UsagePage onNotify={vi.fn()} host={host(async () => { throw new Error("Host extension Usage is not active."); })} />);
    expect((await screen.findAllByText("Host extension Usage is not active.")).length).toBeGreaterThan(0);
  });
});

describe("Usage kit", () => {
  it("contributes the Settings page its command opens, and takes both back", () => {
    const { registry } = createKitHarness(answers());
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
