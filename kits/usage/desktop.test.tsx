// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformEnvironments, TauConfig, UiSession, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider, createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import usageExtension from "./desktop.js";
import { UsageLimits } from "./limits.js";
import { UsagePage } from "./page.js";
import { priceFromDraft } from "./prices.js";
import { dayStarts, HISTORY_DAYS } from "./dashboard.js";
import { forgetLastState } from "./last-state.js";
import { USAGE_PAGE, type UsageEntry, type UsageLimitsSummary, type UsageRow, type UsageSummary } from "./protocol.js";
import { resetsIn } from "./view-model.js";

afterEach(() => { forgetLastState(); });
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

// The page asks for a first "day" at 0 that gathers everything older, then its own days: today is the last of them.
const LAST = HISTORY_DAYS;

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
  entry({ day: 0, threadId: "t-older", cwd: "/work/beta", costUsd: 7 }),
];

/** Opens the filters a page without its sidebar keeps in a sheet. */
async function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  return within(await screen.findByRole("dialog", { name: "Usage filters" }));
}

const threadList = () => screen.getAllByRole("region", { name: "Threads" }).at(-1)!;

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
  it("asks for its days after one that gathers everything older, and answers the period's four figures", async () => {
    const invoke = answers();
    renderPage(invoke);
    const totals = await screen.findByLabelText("Totals");
    expect(invoke).toHaveBeenCalledWith("summary", { days: [0, ...dayStarts(HISTORY_DAYS, NOW)] });
    // September so far: $0.01 today and $0.50 on the 2nd; the last week only today's.
    const spend = within(totals).getByRole("region", { name: "API spend" });
    expect(await within(spend).findByText("$0.51")).toBeTruthy();
    expect(within(spend).getByText("$0.01 last week")).toBeTruthy();
    const plans = within(totals).getByRole("region", { name: "On plans" });
    expect(within(plans).getByText("500")).toBeTruthy();
    expect(within(plans).getByText("tokens · ChatGPT")).toBeTruthy();
    expect(within(plans).getByText("500").getAttribute("data-tooltip")).toBe("≈ $1.40 at API prices");
    expect(within(within(totals).getByRole("region", { name: "Threads" })).getByText("3")).toBeTruthy();
    expect(within(within(totals).getByRole("region", { name: "Local" })).getByText("tokens on local models")).toBeTruthy();
    // All time takes in the older work too.
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Period" })).getByRole("radio", { name: "All time" }));
    expect(within(spend).getByText("$7.71")).toBeTruthy();
  });

  it("opens with what it read last time, at once, and replaces it with the fresh answer", async () => {
    const first = renderPage(answers());
    const totals = await screen.findByLabelText("Totals");
    await within(within(totals).getByRole("region", { name: "API spend" })).findByText("$0.51");
    await within(await screen.findByLabelText("Limits")).findByRole("region", { name: "Codex limits" });
    first.unmount();

    // The host is slow to answer the next time: the page does not wait for it.
    const answers2 = new Map<string, (value: unknown) => void>();
    renderPage(vi.fn((command: string) => new Promise((resolve) => { answers2.set(command, resolve); })));
    expect(within(screen.getByRole("region", { name: "API spend" })).getByText("$0.51")).toBeTruthy();
    expect(within(screen.getByLabelText("Limits")).getByRole("region", { name: "Codex limits" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/· updating…$/u);
    answers2.get("summary")?.(summary({ entries: [entry({ costUsd: 0.05 })] }));
    await within(screen.getByRole("region", { name: "API spend" })).findByText("$0.05");
  });

  it("shows this host's figures without waiting for another machine", async () => {
    const environments = {
      getSnapshot: () => ({ shown: "here", secureStorage: true, environments: [
        { id: "here", name: "This Mac", local: true, status: "connected", threads: [], threadCount: 0 },
        { id: "slow-id", name: "slow", local: false, status: "connected", threads: [], threadCount: 0 },
      ] }),
      subscribe: () => () => undefined,
      readExtension: vi.fn(() => new Promise(() => undefined)),
    } as unknown as PlatformEnvironments;
    render(<TestProviders><HostClientProvider client={createFakeHostClient()}><UsagePage host={host(answers())} environments={environments} now={() => NOW} navigate={vi.fn()} /></HostClientProvider></TestProviders>);
    const spend = await screen.findByRole("region", { name: "API spend" });
    expect(await within(spend).findByText("$0.51")).toBeTruthy();
    expect(await within(await screen.findByLabelText("Limits")).findByRole("region", { name: "Codex limits" })).toBeTruthy();
  });

  it("marks work outside Tau, names its sessions and projects, and filters by where it ran", async () => {
    const outside = [
      entry({ day: LAST - 1, backend: "codex", threadId: "019a-cli-session", cwd: "/work/side-project", model: "gpt-5.6-luna", provider: "openai", modelId: "gpt-5.6-luna", costUsd: 3, outside: true }),
    ];
    const invoke = vi.fn(async (command: string) => command === "limits" ? limits : summary({ entries: [...entries, ...outside] }));
    renderPage(invoke);
    await waitFor(() => expect(within(threadList()).getByText("Codex session 019a-cli")).toBeTruthy());
    expect(within(threadList()).getByText("Codex session 019a-cli").getAttribute("data-tooltip")).toBe("Outside Tau · side-project");
    const projects = screen.getByRole("region", { name: "By project" });
    expect(await within(projects).findByText("side-project")).toBeTruthy();
    expect(within(projects).getByText("side-project").getAttribute("data-tooltip")).toBe("/work/side-project · Outside Tau");

    const sheet = await openFilters();
    const where = sheet.getByRole("radiogroup", { name: "Where the work ran" });
    fireEvent.click(within(where).getByRole("radio", { name: "In Tau" }));
    await waitFor(() => expect(within(threadList()).queryByText("Codex session 019a-cli")).toBeNull());
    fireEvent.click(within(where).getByRole("radio", { name: "Outside Tau" }));
    await waitFor(() => expect(within(threadList()).getAllByRole("listitem")).toHaveLength(1));
  });

  it("counts a worktree's threads, and a CLI run in that worktree, with their project; names the costliest thread with its agents", async () => {
    const worktree = "/worktrees/feat-x/alpha";
    const thread = (id: string, path: string, parentThreadId?: string): UiSession => ({ id, path: `/sessions/${id}`, title: id === "t-root" ? "Ship feature X" : id, modifiedAt: 0, projectPath: path, workspaceId: `ws-${path}`, projectName: "alpha", messageCount: 1, ...(parentThreadId ? { parentThreadId } : {}) });
    const worked = [
      entry({ threadId: "t-root", cwd: worktree, costUsd: 1 }),
      entry({ threadId: "t-agent", cwd: worktree, costUsd: 2 }),
      entry({ threadId: "t-main", costUsd: 0.5 }),
      entry({ threadId: "cli-1", cwd: worktree, costUsd: 0.25, outside: true }),
    ];
    const switchSession = vi.fn();
    render(
      <TestProviders><TestThreadStore threads={[thread("t-root", worktree), thread("t-agent", worktree, "t-root"), thread("t-main", "/work/alpha")]} projects={[{ path: "/work/alpha", workspaceId: "ws-/work/alpha", name: "alpha", lastOpenedAt: 0 }]}>
        <HostClientProvider client={createFakeHostClient()}><UsagePage host={host(answers(() => summary({ entries: worked })))} now={() => NOW} actions={{ switchSession } as unknown as WorkbenchActions} /></HostClientProvider>
      </TestThreadStore></TestProviders>,
    );
    const projects = await screen.findByRole("region", { name: "By project" });
    await waitFor(() => expect(within(projects).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Aalpha4$3.75"]));
    expect(within(within(screen.getByLabelText("Totals")).getByRole("region", { name: "Threads" })).getByText("1 agent spawned")).toBeTruthy();
    const costliest = within(projects).getByText(/^Most expensive thread:/u);
    expect(costliest.textContent).toBe("Most expensive thread: Ship feature X · $3.00 across 1 agent");
    fireEvent.click(within(costliest).getByRole("button", { name: "Ship feature X" }));
    expect(switchSession).toHaveBeenCalledWith("/sessions/t-root");
  });

  it("marks a Pi plan account with its plan's mark and a shared ChatGPT account with the ChatGPT plan's", async () => {
    const key = "ab".repeat(32);
    const plans: UsageLimitsSummary = {
      checkedAt: NOW.getTime(),
      sources: [],
      accounts: [
        { id: "pi:anthropic", runtime: "pi", label: "Pi · anthropic", checkedAt: NOW.getTime(), windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 20 }] },
        { id: "codex:account", runtime: "codex", label: "Codex", checkedAt: NOW.getTime(), identity: { provider: "openai", key }, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 30 }] },
        { id: "pi:openai-codex", runtime: "pi", label: "Pi · openai-codex", checkedAt: NOW.getTime() - 60_000, identity: { provider: "openai", key }, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 28 }] },
      ],
    };
    renderPage(vi.fn(async (command: string) => command === "limits" ? plans : summary()));
    const anthropic = await screen.findByRole("region", { name: "Pi · anthropic limits" });
    expect(within(anthropic).getByRole("img", { name: "Pi via Claude plan" })).toBeTruthy();
    const shared = screen.getByRole("region", { name: /^ChatGPT · Codex, Pi limits$/u });
    expect(within(shared).getByRole("img", { name: "ChatGPT plan" })).toBeTruthy();
  });

  it("shows no origin filter when nothing ran outside Tau, and says when the logs are still being read", async () => {
    renderPage(answers(() => summary({ reading: true })));
    // The regions draw before the summary; ask about the filter once it is there.
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("still reading the CLIs' logs"));
    const sheet = await openFilters();
    expect(sheet.getByRole("radiogroup", { name: "Measure" })).toBeTruthy();
    expect(sheet.queryByRole("radiogroup", { name: "Where the work ran" })).toBeNull();
  });

  it("draws the month's days and ranks providers, projects, models and threads by the measure chosen", async () => {
    renderPage(answers());
    const days = await screen.findByRole("list", { name: "Cost per day" });
    // September: the 22 days so far and the 8 to come.
    expect(within(days).getAllByRole("listitem")).toHaveLength(30);
    // The days draw before the summary arrives; the rankings follow it.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "By project" })).getAllByRole("listitem")).toHaveLength(1));
    const providers = within(screen.getByRole("region", { name: "By provider" })).getAllByRole("listitem");
    expect(providers.map((item) => item.textContent)).toEqual(["OpenAI1500 tok", "Anthropic2$0.51"]);
    const models = within(screen.getByRole("region", { name: "Models" })).getAllByRole("listitem");
    expect(models.map((item) => item.querySelector(".usage-table-name")?.textContent)).toEqual(["gpt-5.6-luna", "haiku", "claude-haiku-4-5"]);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Period" })).getByRole("radio", { name: "30 days" }));
    expect(within(screen.getByRole("list", { name: "Cost per day" })).getAllByRole("listitem")).toHaveLength(30);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Period" })).getByRole("radio", { name: "All time" }));
    expect(within(screen.getByRole("list", { name: "Cost per day" })).getAllByRole("listitem")).toHaveLength(90);
    expect(within(screen.getByRole("region", { name: "By project" })).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click((await openFilters()).getByRole("radio", { name: "Tokens" }));
    expect(screen.getByRole("list", { name: "Tokens per day" })).toBeTruthy();
    expect(within(threadList()).getAllByRole("listitem")[0]!.textContent).toContain("1.1k tok");
  });

  it("reads again on request and keeps the figures while it does", async () => {
    const invoke = answers();
    renderPage(invoke);
    await screen.findByLabelText("Totals");
    // The button stays disabled until the limits are read too.
    const again = (await openFilters()).getByRole("button", { name: "Read again" }) as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("summary", expect.objectContaining({ refresh: true })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("limits", { refresh: true }));
    expect(screen.getByLabelText("Totals")).toBeTruthy();
  });

  it("shows what is left of each plan window and when it resets, the plan with the least left first", async () => {
    renderPage(answers());
    const limitsList = await screen.findByLabelText("Limits");
    expect(within(limitsList).getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Codex limits", "Pi · openai-codex limits"]);
    const codex = within(limitsList).getByRole("region", { name: "Codex limits" });
    expect(within(codex).getByText("pro")).toBeTruthy();
    const session = within(codex).getByRole("meter", { name: "5-hour left" });
    expect(session.getAttribute("aria-valuenow")).toBe("66");
    expect(within(codex).getAllByText("% left")).toHaveLength(2);
    expect((session.querySelector(".usage-meter-fill") as HTMLElement).style.width).toBe("66%");
    expect(within(codex).getByText(/^resets in 1h 30m · /u)).toBeTruthy();
    // 3d before the weekly reset, 57 % of the week has passed: at an even pace 43 % would be left, and the diamond sits there.
    const weekly = within(codex).getByRole("meter", { name: "Weekly left" });
    expect(weekly.getAttribute("aria-valuetext")).toBe("5% left, target 43%, Below target");
    expect((weekly.querySelector(".usage-meter-pace") as HTMLElement).style.getPropertyValue("--usage-pace")).toMatch(/^42\.\d+%$/u);
    expect(within(screen.getByRole("region", { name: "Pi · openai-codex limits" })).getByText("Reset time unavailable")).toBeTruthy();
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
    expect(within(account).getAllByRole("meter")).toHaveLength(1);
    expect(within(account).getByRole("meter").getAttribute("aria-valuenow")).toBe("90");
    expect(within(account).getByText("ChatGPT")).toBeTruthy();
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
    // The list draws before the summary that fills it.
    expect(await within(sources).findByText("not available")).toBeTruthy();
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

describe("Usage across machines", () => {
  it("adds the connected machines' usage and limits, one account once, and filters by machine", async () => {
    const identity = { provider: "openai", key: "d".repeat(64) };
    const local: UsageLimitsSummary = { ...limits, accounts: [{ ...limits.accounts[0]!, identity }] };
    const rexLimits: UsageLimitsSummary = { checkedAt: NOW.getTime(), sources: [{ extensionId: "tau.codex", label: "Codex", status: "ok", detail: "1 account, 1 window." }], accounts: [
      { id: "codex:account", runtime: "codex", label: "Codex", checkedAt: NOW.getTime(), identity, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 40, windowMinutes: 300, resetsAt: NOW.getTime() + 90 * 60_000 }] },
      { id: "grok:account", runtime: "grok", label: "Grok", checkedAt: NOW.getTime(), windows: [{ id: "credits", kind: "monthly", label: "Monthly", usedPercent: 20 }] },
    ] };
    const rexEntries = [entry({ backend: "codex", threadId: "t-rex", model: "gpt-5.6-luna", provider: "openai", modelId: "gpt-5.6-luna", costUsd: 2, requests: 5 })];
    const reads: Array<[string, string]> = [];
    const environments = {
      getSnapshot: () => ({ shown: "here", secureStorage: true, environments: [
        { id: "here", name: "This Mac", local: true, status: "connected", threads: [], threadCount: 0 },
        { id: "rex-id", name: "rex", local: false, status: "connected", threads: [], threadCount: 0 },
        { id: "gone-id", name: "old", local: false, status: "offline", threads: [], threadCount: 0 },
      ] }),
      subscribe: () => () => undefined,
      readExtension: vi.fn(async (machine: string, extensionId: string, command: string) => {
        reads.push([machine, `${extensionId} ${command}`]);
        return command === "limits" ? rexLimits : summary({ entries: rexEntries });
      }),
    } as unknown as PlatformEnvironments;
    render(<TestProviders><HostClientProvider client={createFakeHostClient()}><UsagePage host={host(vi.fn(async (command: string) => command === "limits" ? local : summary()))} environments={environments} now={() => NOW} navigate={vi.fn()} /></HostClientProvider></TestProviders>);
    const spend = await screen.findByRole("region", { name: "API spend" });
    await waitFor(() => expect(within(spend).getByText("$2.51")).toBeTruthy());
    expect(reads).toEqual(expect.arrayContaining([["rex-id", "tau.usage summary"], ["rex-id", "tau.usage limits"]]));
    expect(reads.some(([machine]) => machine !== "rex-id")).toBe(false);
    // The limits are an answer of their own, apart from the summary.
    const limitsList = await screen.findByLabelText("Limits");
    await waitFor(() => expect(within(limitsList).getByRole("region", { name: "ChatGPT · Codex, Codex on rex limits" })).toBeTruthy());
    expect(within(limitsList).getByRole("region", { name: "Grok on rex limits" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/this computer and rex$/u);
    fireEvent.click(within((await openFilters()).getByRole("radiogroup", { name: "Machine" })).getByText("rex"));
    expect(within(threadList()).getAllByRole("listitem").map((item) => item.querySelector(".usage-table-name > :nth-child(2)")?.getAttribute("data-tooltip"))).toEqual([expect.stringContaining("rex")]);
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

it("opens the provider's usage management page for plans that report no quota windows", () => {
  const open = vi.fn();
  render(<UsageLimits limits={{ checkedAt: NOW.getTime(), sources: [], accounts: [{ id: "plan", runtime: "codex", label: "ChatGPT plan", checkedAt: NOW.getTime(), windows: [], managementUrl: "https://chatgpt.com/settings/usage", unavailable: { reason: "unsupported", message: "ChatGPT manages this connection's usage." } }] }} error={undefined} now={NOW.getTime()} onOpenExternal={open} />);
  fireEvent.click(screen.getByRole("link", { name: "Manage usage" }));
  expect(open).toHaveBeenCalledWith("https://chatgpt.com/settings/usage");
});
