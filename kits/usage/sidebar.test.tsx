// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { UsageSidebar } from "./controls.js";
import { dayStarts, HISTORY_DAYS } from "./dashboard.js";
import { createUsageView } from "./filters.js";
import { createJuicebarChoices } from "./juicebars.js";
import { Juicebars } from "./juicebars-view.js";
import { forgetLastState } from "./last-state.js";
import { createLimitsFeed } from "./limits-feed.js";
import { UsagePage } from "./page.js";
import type { UsageEntry, UsageLimitsSummary, UsageSummary } from "./protocol.js";

const NOW = new Date(2026, 8, 22, 15, 30);
const days = dayStarts(HISTORY_DAYS, NOW);
const LAST = HISTORY_DAYS - 1;
const scrolled: string[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.id); };
});
afterEach(() => { forgetLastState(); cleanup(); vi.useRealTimers(); });

function entry(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    day: LAST, backend: "pi", threadId: "t-alpha", cwd: "/work/alpha", model: "anthropic/claude-haiku-4-5", provider: "anthropic", modelId: "claude-haiku-4-5",
    requests: 1, inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100, costUsd: 2, apiValueUsd: 0,
    ...overrides,
  };
}

const entries = [
  entry({}),
  entry({ day: LAST - 3, backend: "codex", threadId: "t-codex", model: "gpt-5.6-luna", provider: "openai", billing: "subscription", costUsd: 0, apiValueUsd: 1.4, requests: 2, totalTokens: 500 }),
  // The same days of August: the 10th counts against September's first 22.
  entry({ day: days.indexOf(new Date(2026, 7, 10).getTime()), threadId: "t-august", costUsd: 1 }),
];

const summary = (): UsageSummary => ({
  entries, scannedAt: NOW.getTime(), rows: [], sources: [],
  totals: { requests: 4, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2_700, costUsd: 3, threads: 3, subscription: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 500, requests: 2, apiValueUsd: 1.4 } },
});

const limits: UsageLimitsSummary = {
  checkedAt: NOW.getTime(),
  accounts: [
    { id: "codex:account", runtime: "codex", label: "Codex", plan: "pro", checkedAt: NOW.getTime() - 60_000, identity: { provider: "openai", key: "k" }, windows: [
      { id: "primary", kind: "session", label: "5-hour", usedPercent: 41, windowMinutes: 300, resetsAt: NOW.getTime() + 90 * 60_000 },
      { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 95, windowMinutes: 10_080, resetsAt: NOW.getTime() + 3 * 86_400_000 },
      { id: "model.spark", kind: "weekly", label: "Weekly · Spark", usedPercent: 5, windowMinutes: 10_080, resetsAt: NOW.getTime() + 3 * 86_400_000 },
    ] },
    { id: "claude-code:account", runtime: "claude-code", label: "Claude Code", checkedAt: NOW.getTime(), windows: [], unavailable: { reason: "unsupported", message: "An API key has no plan limits." } },
  ],
  sources: [],
};

const host = (invoke: (command: string) => Promise<unknown>): HostExtensionClient => ({ invoke, onEvent: () => () => undefined }) as unknown as HostExtensionClient;
const answers = vi.fn(async (command: string) => command === "limits" ? limits : summary());

describe("Usage's page sidebar", () => {
  it("carries the month and the filters; the page drops its own and follows the sidebar's", async () => {
    const view = createUsageView();
    render(
      <TestProviders><HostClientProvider client={createFakeHostClient()}>
        <nav aria-label="Usage sidebar"><UsageSidebar view={view} /></nav>
        <UsagePage host={host(answers)} now={() => NOW} navigate={vi.fn()} sidebar view={view} />
      </HostClientProvider></TestProviders>,
    );
    const side = within(screen.getByRole("navigation", { name: "Usage sidebar" }));
    const month = await side.findByRole("region", { name: "This month" });
    await waitFor(() => expect(within(month).getByText("$2.00")).toBeTruthy());
    expect(month.textContent).toContain("≈ $1.40 plan value");
    expect(month.textContent).toContain("+100% on August by this day");
    expect(month.textContent).toMatch(/On pace for \$2\.\d\d/u);
    // One set of filters on screen: the sidebar's.
    expect(screen.getAllByRole("radiogroup", { name: "Measure" })).toHaveLength(1);
    const page = screen.getByRole("region", { name: "Threads" });
    fireEvent.click(within(side.getByRole("radiogroup", { name: "Runtime" })).getByRole("radio", { name: "Codex" }));
    expect(within(page).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(side.getByRole("radiogroup", { name: "Measure" })).getByText("Tokens"));
    expect(within(page).getByText("500 tok")).toBeTruthy();
    fireEvent.click(side.getByRole("link", { name: "Models" }));
    expect(scrolled).toEqual(["usage-models"]);
  });

  it("keeps the month and the filters on top of the page without a sidebar, and opens at the section asked for", async () => {
    render(<TestProviders><HostClientProvider client={createFakeHostClient()}><UsagePage host={host(answers)} now={() => NOW} navigate={vi.fn()} params={{ section: "limits" }} /></HostClientProvider></TestProviders>);
    const month = await screen.findByRole("region", { name: "This month" });
    await waitFor(() => expect(within(month).getByText("$2.00")).toBeTruthy());
    expect(screen.getByRole("radiogroup", { name: "Range" })).toBeTruthy();
    await waitFor(() => expect(scrolled).toContain("usage-limits"));
  });

  it("lets each plan choose the windows the sidebar's foot draws", async () => {
    const choices = createJuicebarChoices();
    render(<TestProviders><HostClientProvider client={createFakeHostClient()}><UsagePage host={host(answers)} now={() => NOW} navigate={vi.fn()} choices={choices} /></HostClientProvider></TestProviders>);
    const card = await screen.findByRole("region", { name: "Codex limits" });
    const choice = within(card).getByRole("group", { name: "Show in sidebar" });
    expect(within(choice).getAllByRole("button").map((button) => `${button.textContent} ${button.getAttribute("aria-pressed")}`)).toEqual(["5-hour true", "Weekly true", "Weekly · Spark false"]);
    fireEvent.click(within(choice).getByRole("button", { name: "Weekly · Spark" }));
    expect(choices.getSnapshot()).toEqual({ "openai:k|model.spark": true });
    // An account without limits has no card, so nothing to choose.
    expect(screen.getAllByRole("group", { name: "Show in sidebar" })).toHaveLength(1);
  });
});

describe("the juicebars at the sidebar's foot", () => {
  // The bars judge a reading against the clock: the fixture's.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
  const renderBars = (feed: ReturnType<typeof createLimitsFeed>, openPage = vi.fn()) => {
    render(
      <TestProviders><TestThreadStore threads={[]}>
        <Juicebars actions={{ openPage } as unknown as WorkbenchActions} feed={feed} choices={createJuicebarChoices()} />
      </TestThreadStore></TestProviders>,
    );
    return openPage;
  };

  it("draws Usage's icon until a plan reports its windows, then a bar per shown window; a click opens the limits", async () => {
    const invoke = vi.fn(async () => limits);
    const feed = createLimitsFeed(host(invoke));
    const openPage = renderBars(feed);
    expect(screen.getByRole("button", { name: "Usage" })).toBeTruthy();
    act(() => feed.publish(limits));
    const bars = screen.getByRole("button", { name: "Plan limits, Codex: 5-hour 59% left, Weekly 5% left" });
    expect([...bars.querySelectorAll(".usage-juicebar")].map((bar) => [(bar as HTMLElement).style.getPropertyValue("--usage-left"), bar.getAttribute("data-level")])).toEqual([["59%", null], ["5%", "warn"]]);
    fireEvent.click(bars);
    expect(openPage).toHaveBeenCalledWith("usage", { section: "limits" });
  });

  it("tells each bar on its card: account, window, what is left and the reset", () => {
    const feed = createLimitsFeed(host(vi.fn(async () => limits)));
    renderBars(feed);
    act(() => feed.publish(limits));
    const bars = screen.getByRole("button", { name: /^Plan limits/u });
    fireEvent.focus(bars);
    const card = screen.getByRole("tooltip");
    expect(within(card).getByText("Codex")).toBeTruthy();
    expect(within(card).getByText("59% left")).toBeTruthy();
    expect(card.textContent).toContain("resets in 1h 30m");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("reads every machine's limits a moment after it is drawn, and again after a run ends", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const invoke = vi.fn(async () => limits);
    const feed = createLimitsFeed(host(invoke));
    const stop = feed.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot()?.accounts).toHaveLength(2);
    feed.runEnded();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    stop();
  });
});
