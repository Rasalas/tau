// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PlatformEnvironments, UiEnvironments, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, createMemoryStorage, HostClientProvider, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { usageExtension } from "./desktop.js";
import { JuicebarStrip } from "./juicebar-strip.js";
import { createJuicebarChoices } from "./juicebars.js";
import { createLimitsFeed } from "./limits-feed.js";
import { forgetLastState } from "./last-state.js";
import { UsagePage } from "./page.js";
import type { UsageLimitAccount, UsageLimitsSummary } from "./protocol.js";

const NOW = new Date(2026, 8, 29, 15, 30).getTime();

const account = (id: string, runtime: string, used: number[], identity?: { provider: string; key: string }, checkedAt = NOW - 60_000): UsageLimitAccount => ({
  id, runtime, label: runtime === "codex" ? "Codex" : "Claude Code", checkedAt, ...(identity ? { identity } : {}),
  windows: [
    { id: "primary", kind: "session", label: "5-hour", usedPercent: used[0]!, windowMinutes: 300, resetsAt: NOW + 3_600_000 },
    { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: used[1]!, windowMinutes: 10_080, resetsAt: NOW + 86_400_000 },
  ],
});

const host = (answer: unknown): HostExtensionClient => ({ invoke: vi.fn(async () => answer), onEvent: () => () => undefined }) as unknown as HostExtensionClient;

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { forgetLastState(); cleanup(); vi.useRealTimers(); setClientStorage(undefined); document.body.removeAttribute("data-profile"); document.querySelector(".touch-browser")?.remove(); });

describe("the juicebars on top of a phone's thread list", () => {
  const renderStrip = (feed: ReturnType<typeof createLimitsFeed>, openPage = vi.fn()) => {
    render(<TestProviders><TestThreadStore threads={[]}>
      <JuicebarStrip actions={{ openPage } as unknown as WorkbenchActions} feed={feed} choices={createJuicebarChoices()} />
    </TestThreadStore></TestProviders>);
    return openPage;
  };

  it("draws nothing until a plan has a window, then each account once with only its bars; a tap opens the limits", () => {
    const feed = createLimitsFeed(host(undefined));
    const openPage = renderStrip(feed);
    expect(screen.queryByRole("button")).toBeNull();
    const limits: UsageLimitsSummary = {
      checkedAt: NOW,
      accounts: [
        account("codex:a", "codex", [41, 95], { provider: "openai", key: "k" }),
        // The same account read on another machine: one group under its provider, the fresher reading.
        { ...account("codex:a", "codex", [50, 96], { provider: "openai", key: "k" }, NOW - 10_000), machine: "rex", label: "Codex on rex" },
      ],
      sources: [],
    };
    act(() => feed.publish(limits));
    const strip = screen.getByRole("button", { name: "Plan limits, ChatGPT: 5-hour 50% left, Weekly 4% left. Opens Usage." });
    const groups = strip.querySelectorAll(".usage-juicebar-group");
    expect(groups).toHaveLength(1);
    expect(strip.textContent).toBe("");
    expect(groups[0]!.querySelectorAll('[data-level="warn"]')).toHaveLength(1);
    expect(groups[0]!.querySelectorAll(".usage-juicebar")).toHaveLength(2);
    fireEvent.click(strip);
    expect(openPage).toHaveBeenCalledWith("usage", { section: "limits" });
  });

  it("is registered for a phone's or tablet's thread list only", () => {
    const desktop = createKitHarness();
    desktop.registry.activate(usageExtension);
    expect(desktop.registry.getRegions("thread-list-title")).toEqual([]);
    const phone = createKitHarness(undefined, "compact");
    phone.registry.activate(usageExtension);
    expect(phone.registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["usage.juicebars"]);
  });

  it("reads the other paired hosts' limits through the phone's machines", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const list: UiEnvironments = { shown: "mac", secureStorage: true, environments: [
      { id: "mac", name: "Mac", local: false, status: "connected", threads: [], threadCount: 0, projects: [] },
      { id: "rex", name: "rex", local: false, status: "connected", threads: [], threadCount: 0, projects: [] },
      { id: "box", name: "box", local: false, status: "offline", threads: [], threadCount: 0, projects: [] },
    ] };
    const readExtension = vi.fn(async () => ({ checkedAt: 1, accounts: [account("claude:a", "claude-code", [10, 20], { provider: "anthropic", key: "a" })], sources: [] }));
    const environments = { getSnapshot: () => list, subscribe: () => () => undefined, readExtension } as unknown as PlatformEnvironments;
    const feed = createLimitsFeed(host({ checkedAt: 1, accounts: [], sources: [] }), environments);
    const stop = feed.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    // Only the host it can reach, and not the one on screen.
    expect(readExtension).toHaveBeenCalledWith("rex", "tau.usage", "limits", {});
    expect(readExtension).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot()?.accounts.map((entry) => entry.label)).toEqual(["Claude Code on rex"]);
    stop();
  });
});

describe("choosing a phone's bars on its Usage page", () => {
  it("names the thread list, not a sidebar the phone does not have", async () => {
    setClientStorage(createMemoryStorage());
    document.body.dataset.profile = "compact";
    const limits: UsageLimitsSummary = { checkedAt: NOW, accounts: [account("codex:a", "codex", [41, 95], { provider: "openai", key: "k" })], sources: [] };
    const answers = vi.fn(async (command: string) => command === "limits" ? limits : { entries: [], scannedAt: NOW, rows: [], sources: [], totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0 } });
    const client = { invoke: answers, onEvent: () => () => undefined } as unknown as HostExtensionClient;
    const choices = createJuicebarChoices();
    render(<TestProviders><HostClientProvider client={createFakeHostClient()}><UsagePage host={client} now={() => new Date(NOW)} navigate={vi.fn()} choices={choices} /></HostClientProvider></TestProviders>);
    const card = await screen.findByRole("region", { name: "Codex limits" });
    const choice = within(card).getByRole("group", { name: "Show in thread list" });
    fireEvent.click(within(choice).getByRole("button", { name: "Weekly" }));
    expect(choices.getSnapshot()).toEqual({ "openai:k|secondary": false });
  });

  it("names the sidebar on a tablet, whose sidebar's foot draws them", async () => {
    setClientStorage(createMemoryStorage());
    document.body.dataset.profile = "compact";
    const sidebar = document.body.appendChild(document.createElement("nav"));
    sidebar.className = "touch-browser sidebar";
    const limits: UsageLimitsSummary = { checkedAt: NOW, accounts: [account("codex:a", "codex", [41, 95], { provider: "openai", key: "k" })], sources: [] };
    const answers = vi.fn(async (command: string) => command === "limits" ? limits : { entries: [], scannedAt: NOW, rows: [], sources: [], totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0 } });
    const client = { invoke: answers, onEvent: () => () => undefined } as unknown as HostExtensionClient;
    render(<TestProviders><HostClientProvider client={createFakeHostClient()}><UsagePage host={client} now={() => new Date(NOW)} navigate={vi.fn()} choices={createJuicebarChoices()} /></HostClientProvider></TestProviders>);
    const card = await screen.findByRole("region", { name: "Codex limits" });
    expect(within(card).getByRole("group", { name: "Show in sidebar" })).toBeTruthy();
  });
});
