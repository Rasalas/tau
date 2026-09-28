// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiContextUsage, WorkbenchActions } from "tau";
import { createKitHarness, ThreadStore, ThreadStoreContext, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import { createResumeCompactionBanner } from "./banner.js";
import resumeCompaction from "./desktop.js";
import { RESUME_COMPACTION_OPT_OUT_SERVICE, type ResumeCompactionOptOut } from "./protocol.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.UTC(2026, 8, 28, 12);
const MINUTE = 60_000;
const usage = (tokens: number, minutesAgo: number, promptCacheTtlMs: number | null = 60 * MINUTE): UiContextUsage => ({
  tokens, contextWindow: 200_000, percent: tokens / 2_000, updatedAt: NOW - minutesAgo * MINUTE,
  ...(promptCacheTtlMs !== null ? { promptCacheTtlMs } : {}),
});
const snapshot = (contextUsage: UiContextUsage | undefined, extra: Partial<HostSnapshot> = {}): HostSnapshot => ({
  sessionId: "t1", threadId: "t1", backendKind: "claude-code", isStreaming: false, messages: [], models: [],
  runtimeBackends: [{ kind: "claude-code", label: "Claude Code" }, { kind: "pi", label: "Pi" }],
  ...(contextUsage ? { contextUsage } : {}), ...extra,
} as unknown as HostSnapshot);

function setup(options: { now?: () => number } = {}) {
  const { registry, preferences } = createKitHarness();
  registry.activate(resumeCompaction);
  const threads = new ThreadStore();
  const region = registry.getRegions("composer-above").find((entry) => entry.id === "resume-compaction.offer")!;
  const Banner = options.now ? createResumeCompactionBanner({ preferences, now: options.now }) : region.Component;
  let finish: () => void = () => undefined;
  const compactContext = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const actions = { compactContext, notify: vi.fn() } as unknown as WorkbenchActions;
  const draw = (value: HostSnapshot, drawn: WorkbenchActions = actions) => (
    <ThreadStoreContext.Provider value={threads}><Banner snapshot={value} actions={drawn} /></ThreadStoreContext.Provider>
  );
  return { registry, preferences, threads, region, actions, compactContext, finish: () => finish(), draw };
}

const offer = () => screen.queryByRole("region", { name: "Resume with less context" });

describe("Resume with less context", () => {
  it("offers a compaction for a large context whose cache went cold, and compacts on request", async () => {
    const { draw, compactContext, finish } = setup({ now: () => NOW });
    render(draw(snapshot(usage(153_412, 71))));
    expect(offer()?.textContent).toContain("Resume with less context153k tokens from earlier");

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(compactContext).toHaveBeenCalledTimes(1);
    // While it runs the button says so and takes no second click.
    const running = screen.getByRole("button", { name: "Compacting…" }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    await act(async () => { finish(); });
    expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
  });

  it("stays away below 100k tokens, before 70 minutes, for a runtime without a prompt cache, and while a turn runs", () => {
    const { draw } = setup({ now: () => NOW });
    const view = render(draw(snapshot(usage(99_999, 120))));
    expect(offer()).toBeNull();
    view.rerender(draw(snapshot(usage(153_000, 69))));
    expect(offer()).toBeNull();
    view.rerender(draw(snapshot(usage(153_000, 120, null), { backendKind: "codex" })));
    expect(offer()).toBeNull();
    view.rerender(draw(snapshot(usage(153_000, 120), { isStreaming: true })));
    expect(offer()).toBeNull();
    view.rerender(draw(snapshot(usage(153_000, 120))));
    expect(offer()).not.toBeNull();
  });

  it("appears by itself once the 70 minutes pass", () => {
    vi.useFakeTimers({ now: NOW });
    const { draw } = setup();
    render(draw(snapshot(usage(153_000, 60))));
    expect(offer()).toBeNull();
    act(() => { vi.advanceTimersByTime(11 * MINUTE); });
    expect(offer()).not.toBeNull();
  });

  it("hides while a question waits on the thread", () => {
    const { draw, threads } = setup({ now: () => NOW });
    render(draw(snapshot(usage(153_000, 120))));
    expect(offer()).not.toBeNull();
    act(() => threads.setWaiting(["t1"]));
    expect(offer()).toBeNull();
    act(() => threads.setWaiting([]));
    expect(offer()).not.toBeNull();
  });

  it("keeps the full history for this thread and this measurement only, in the config every device reads", () => {
    const { draw, preferences } = setup({ now: () => NOW });
    const view = render(draw(snapshot(usage(153_000, 120))));
    fireEvent.click(screen.getByRole("button", { name: "Keep full history" }));
    expect(offer()).toBeNull();
    expect(JSON.parse(preferences.value("tau.resume-compaction", "kept") ?? "[]")).toEqual([`t1@${NOW - 120 * MINUTE}`]);
    view.rerender(draw(snapshot(usage(153_000, 120), { sessionId: "t2", threadId: "t2" })));
    expect(offer()).not.toBeNull();
    // The next turn measures the context again, and the offer returns once it is cold again.
    view.rerender(draw(snapshot(usage(160_000, 90))));
    expect(offer()).not.toBeNull();
  });

  it("gives the reason when this client cannot compact", () => {
    const { draw } = setup({ now: () => NOW });
    render(draw(snapshot(usage(153_000, 120)), { notify: vi.fn() } as unknown as WorkbenchActions));
    const button = screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.getAttribute("data-tooltip")).toBe("Compaction is unavailable here.");
  });

  it("turns off for a runtime through its service, and Settings turns it back on", () => {
    const { registry, draw } = setup({ now: () => NOW });
    let service: ResumeCompactionOptOut | undefined;
    registry.activate({ id: "test.runtime", name: "Runtime", activate: (context) => context.useService<ResumeCompactionOptOut>(RESUME_COMPACTION_OPT_OUT_SERVICE, (value) => { service = value; }) });
    render(draw(snapshot(usage(153_000, 120))));
    act(() => service!.turnOff("claude-code"));
    expect(offer()).toBeNull();

    const page = registry.getSettingsPages().find((entry) => entry.id === "resume-compaction.settings")!;
    expect(page.group).toBe("threads");
    const Page = page.Component;
    render(<WorkbenchShellContext.Provider value={{ snapshot: snapshot(undefined), registry }}><Page onNotify={vi.fn()} /></WorkbenchShellContext.Provider>);
    fireEvent.click(screen.getByRole("switch", { name: "Offer to compact Claude Code threads" }));
    expect(offer()).not.toBeNull();
    expect(screen.getByText("Offered on every runtime")).toBeTruthy();
  });
});
