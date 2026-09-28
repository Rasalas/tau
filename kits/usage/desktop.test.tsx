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
import { dayStarts, HISTORY_DAYS } from "./dashboard.js";
import { USAGE_PAGE, type UsageEntry, type UsageLimitsSummary, type UsageRow, type UsageSummary } from "./protocol.js";
import { resetsIn } from "./view-model.js";

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

const LAST = HISTORY_DAYS - 1;

function entry(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    day: LAST, backend: "pi", threadId: "t-alpha", cwd: "/work/alpha", model: "anthropic/claude-haiku-4-5", provider: "anthropic", modelId: "claude-haiku-4-5",
    requests: 1, inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100, costUsd: 0.01, apiValueUsd: 0,
    ...overrides,
  };
}

const entries = [
  entry({}),
  entry({ day: LAST - 3, backend: "codex", threadId: "t-codex", model: "gpt-5.6-luna", provider: "openai", modelId: "gpt-5.6-luna", billing: "subscription", costUsd: 0, apiValueUsd: 1.4, requests: 2, totalTokens: 500 }),
  entry({ day: LAST - 20, backend: "claude-code", threadId: "t-sdk", model: "haiku", provider: undefined, modelId: "haiku", costUsd: 0.5, requests: 3 }),
  entry({ day: LAST - 40, threadId: "t-beta", cwd: "/work/beta", costUsd: 0.2 }),
];

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    entries,
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
  const navigate = vi.fn();
  const view = render(<TestProviders><HostClientProvider client={client}><UsagePage host={host(invoke)} now={() => NOW} navigate={navigate} /></HostClientProvider></TestProviders>);
  const show = (params: Record<string, unknown>) => view.rerender(<TestProviders><HostClientProvider client={client}><UsagePage host={host(invoke)} now={() => NOW} navigate={navigate} params={params} /></HostClientProvider></TestProviders>);
  return { ...view, navigate, show };
}

describe("Usage page", () => {
  it("asks for the last 90 of the user's days and answers today, the week and the month, money and plan value apart", async () => {
    const invoke = answers();
    renderPage(invoke);
    const totals = await screen.findByLabelText("Totals");
    const days = dayStarts(HISTORY_DAYS, NOW);
    expect(invoke).toHaveBeenCalledWith("summary", { since: days[0], days });
    const today = within(totals).getByRole("region", { name: "Today" });
    expect(within(today).getByText("$0.01")).toBeTruthy();
    expect(within(today).getByText("—")).toBeTruthy();
    const week = within(totals).getByRole("region", { name: "Last 7 days" });
    expect(within(week).getByText("≈ $1.40")).toBeTruthy();
    expect(within(week).getByText(/1\.6k tokens · 3 turns · 2 threads/u)).toBeTruthy();
    expect(within(within(totals).getByRole("region", { name: "Last 30 days" })).getByText("$0.51")).toBeTruthy();
  });

  it("draws the days of the range and ranks projects, models and threads by the measure chosen", async () => {
    renderPage(answers());
    const days = await screen.findByRole("list", { name: "Cost per day" });
    expect(within(days).getAllByRole("listitem")).toHaveLength(30);
    // The days draw before the summary arrives; the rankings follow it.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Projects" })).getAllByRole("listitem")).toHaveLength(1));
    const models = within(screen.getByRole("region", { name: "Models" })).getAllByRole("listitem");
    expect(models.map((item) => item.querySelector("strong")?.textContent)).toEqual(["gpt-5.6-luna", "haiku", "claude-haiku-4-5"]);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Range" })).getByText("90 days"));
    expect(within(screen.getByRole("list", { name: "Cost per day" })).getAllByRole("listitem")).toHaveLength(90);
    expect(within(screen.getByRole("region", { name: "Projects" })).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Measure" })).getByText("Tokens"));
    expect(screen.getByRole("list", { name: "Tokens per day" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Threads" })).getAllByRole("listitem")[0]!.textContent).toContain("1.1k tok");
  });

  it("reads again on request and keeps the figures while it does", async () => {
    const invoke = answers();
    renderPage(invoke);
    await screen.findByLabelText("Totals");
    // The button stays disabled until the limits are read too.
    const again = screen.getByRole("button", { name: "Read usage and limits again" }) as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("summary", expect.objectContaining({ refresh: true })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("limits", { refresh: true }));
    expect(screen.getByLabelText("Totals")).toBeTruthy();
  });

  it("shows how much of each plan window is used and when it resets, the fullest plan first", async () => {
    renderPage(answers());
    const limitsList = await screen.findByLabelText("Limits");
    expect(within(limitsList).getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Codex limits", "Pi · openai-codex limits"]);
    const codex = within(limitsList).getByRole("region", { name: "Codex limits" });
    expect(within(codex).getByText("pro")).toBeTruthy();
    expect(within(codex).getByText("34% used")).toBeTruthy();
    expect(within(codex).getByText("resets in 1h 30m")).toBeTruthy();
    const weekly = within(codex).getByRole("img", { name: /^Weekly: 95% used/u });
    expect(weekly.getAttribute("data-low")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Accounts without limits" })).getByText(/An API key or a cloud provider has no plan limits/u)).toBeTruthy();
  });

  it("shows runtimes signed in to one account once: its limits from the latest read, their costs summed and itemised", async () => {
    const identity = { provider: "openai", key: "c".repeat(64) };
    const shared: UsageLimitsSummary = { ...limits, accounts: limits.accounts.map((account) => account.runtime === "claude-code" ? account : { ...account, identity }) };
    const withPi = [...entries, entry({ day: LAST - 1, threadId: "t-pi", model: "openai-codex/gpt-5.6-luna", provider: "openai-codex", modelId: "gpt-5.6-luna", billing: "subscription", costUsd: 0, apiValueUsd: 0.2 })];
    renderPage(vi.fn(async (command: string) => command === "limits" ? shared : summary({ entries: withPi })));
    const limitsList = await screen.findByLabelText("Limits");
    expect(within(limitsList).getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["ChatGPT · Codex, Pi limits"]);
    const account = within(limitsList).getByRole("region", { name: "ChatGPT · Codex, Pi limits" });
    expect(within(account).getAllByRole("img", { name: /^5-hour:/u })).toHaveLength(1);
    expect(within(account).getByText("10% used")).toBeTruthy();
    expect(within(account).getByText(/via Pi/u)).toBeTruthy();
    expect(within(account).getByText("pro")).toBeTruthy();
    await waitFor(() => expect(account.querySelector(".usage-account-cost")?.textContent).toBe("Last 30 days: ≈ $1.60 plan value (Codex ≈ $1.40, Pi ≈ $0.20)"));
    expect(account.textContent).not.toContain(identity.key);
  });

  it("says where the numbers would come from before anything was used", async () => {
    const empty = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0, subscription: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0, apiValueUsd: 0 } };
    const { navigate } = renderPage(answers(() => summary({ rows: [], totals: empty, entries: [] })));
    expect(await screen.findByText("Nothing used yet")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Sources" })[0]!);
    expect(navigate).toHaveBeenCalledWith({ view: "sources" }, { label: "Sources" });
  });

  it("lists the sources on a view of its own", async () => {
    const view = renderPage(answers());
    await screen.findByLabelText("Totals");
    view.show({ view: "sources" });
    const sources = await screen.findByLabelText("Sources");
    expect(within(sources).getByText("not available")).toBeTruthy();
    expect(within(sources).getByText(/tau\.antigravity is not installed/u)).toBeTruthy();
    await waitFor(() => expect(within(screen.getByLabelText("Sources")).getByText("Codex limits")).toBeTruthy());
  });

  it("adds, edits and resets the user's own model prices in Tau's config", async () => {
    const config = { host: { modelPrices: { "openai/o4-mini": { input: 1.1, output: 4.4 } } } as TauConfig, updates: [] as Array<Partial<TauConfig>>, cleared: [] as string[][] };
    const view = renderPage(answers(), config);
    await screen.findByLabelText("Totals");
    view.show({ view: "prices" });
    const table = await screen.findByRole("table", { name: "Your model prices" });
    await waitFor(() => expect(within(table).getByText("openai/o4-mini")).toBeTruthy());
    const output = within(table).getByRole("spinbutton", { name: "Output price of openai/o4-mini" });
    fireEvent.change(output, { target: { value: "4" } });
    fireEvent.blur(output);
    await waitFor(() => expect(config.updates.at(-1)).toEqual({ modelPrices: { "openai/o4-mini": { input: 1.1, output: 4 } } }));
    // A required rate is refused when emptied; nothing is written.
    const input = within(table).getByRole("spinbutton", { name: "Input price of openai/o4-mini" });
    const written = config.updates.length;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(within(table).getByRole("alert").textContent).toBe("Enter a number.");
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.blur(input);
    expect(within(table).getByRole("alert").textContent).toBe("Enter 0 or more.");
    expect(config.updates.length).toBe(written);
    fireEvent.keyDown(input, { key: "Escape" });

    const add = screen.getByRole("form", { name: "Add a model price" });
    fireEvent.click(within(add).getByRole("button", { name: "Add price" }));
    expect(screen.getByRole("status").textContent).toMatch(/Enter a model id/u);
    fireEvent.change(within(add).getByRole("combobox", { name: "Model id" }), { target: { value: "gpt-5.6-luna" } });
    for (const [name, value] of [["Input price", "0.2"], ["Output price", "1.2"]] as const) {
      const field = within(add).getByRole("spinbutton", { name });
      fireEvent.change(field, { target: { value } });
      fireEvent.blur(field);
    }
    fireEvent.click(within(add).getByRole("button", { name: "Add price" }));
    await waitFor(() => expect(config.updates.at(-1)?.modelPrices?.["gpt-5.6-luna"]).toEqual({ input: 0.2, output: 1.2 }));
    expect(screen.getByRole("status").textContent).toBe("Added a price for gpt-5.6-luna.");

    fireEvent.click(within(screen.getByRole("table", { name: "Your model prices" })).getByRole("button", { name: "Reset gpt-5.6-luna to automatic" }));
    await waitFor(() => expect(config.cleared.at(-1)).toEqual(["modelPrices.gpt-5.6-luna"]));
  });

  it("says when there are no prices of the user's own", async () => {
    const view = renderPage(answers());
    await screen.findByLabelText("Totals");
    view.show({ view: "prices" });
    expect(await screen.findByText("No prices of your own")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Your model prices" })).toBeNull();
    expect(screen.getByRole("form", { name: "Add a model price" })).toBeTruthy();
  });

  it("says so when the host half cannot answer", async () => {
    render(<UsagePage host={host(async () => { throw new Error("Host extension Usage is not active."); })} />);
    expect((await screen.findAllByText("Host extension Usage is not active.")).length).toBeGreaterThan(0);
  });

  it("counts down to a reset", () => {
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

describe("Usage kit", () => {
  it("contributes an app page and the command that opens it, and takes both back", () => {
    const { registry } = createKitHarness(answers());
    registry.activate(usageExtension);
    expect(registry.getPages().map((page) => [page.id, page.label, page.layout])).toEqual([[USAGE_PAGE, "Usage", "wide"]]);
    expect(registry.getSettingsPages()).toEqual([]);
    const openPage = vi.fn();
    void registry.getCommands().find((command) => command.id === "usage.open")?.run({ openPage } as unknown as WorkbenchActions);
    expect(openPage).toHaveBeenCalledWith(USAGE_PAGE);
    registry.deactivate(usageExtension.id);
    expect(registry.getPages()).toEqual([]);
    expect(registry.getCommands().filter((command) => command.id === "usage.open")).toEqual([]);
  });
});
