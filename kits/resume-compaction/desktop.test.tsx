// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiContextUsage, WorkbenchActions } from "tau";
import { createKitHarness, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import resumeCompaction from "./desktop.js";
import { RESUME_COMPACTION_OPT_OUT_SERVICE, type ResumeCompactionOptOut } from "./protocol.js";
import { createResumeCompactionSendMode } from "./send-mode.js";

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
  const registered = registry.getComposerSendModes().find((entry) => entry.id === "resume-compaction.send")!;
  const mode = options.now ? createResumeCompactionSendMode({ preferences, now: options.now }) : registered;
  return { registry, preferences, mode };
}

describe("Compact and send", () => {
  it("compacts before the prompt for a large context whose cache went cold", async () => {
    const { mode } = setup({ now: () => NOW });
    const offered = mode.read(snapshot(usage(153_412, 71)))!;
    expect(offered).toMatchObject({ label: "Compact and send", busyLabel: "Compacting…", title: "Summarize 153k tokens of earlier history, then send" });
    expect(offered.options?.map((option) => [option.label, option.detail, option.send])).toEqual([
      ["Send with full history", "Re-reads all 153k tokens", true],
      ["Always send with full history", "Stops offering this for Claude Code", true],
    ]);
    // The same answer until something changes, as useSyncExternalStore needs.
    expect(mode.read(snapshot(usage(153_412, 71)))).toBe(offered);

    const compactContext = vi.fn(async () => undefined);
    await offered.beforeSend({ compactContext } as unknown as WorkbenchActions);
    expect(compactContext).toHaveBeenCalledTimes(1);
    await expect(offered.beforeSend({} as WorkbenchActions)).rejects.toThrow("Compaction is unavailable here.");
    // A compaction that failed keeps the prompt: sending it would re-read everything after all.
    await expect(offered.beforeSend({ compactContext: async () => false } as unknown as WorkbenchActions)).rejects.toThrow(/^Not sent: the compaction failed/u);
  });

  it("sends as usual below 100k tokens, before 70 minutes, and for a runtime without a prompt cache", () => {
    const { mode } = setup({ now: () => NOW });
    expect(mode.read(snapshot(usage(99_999, 120)))).toBeUndefined();
    expect(mode.read(snapshot(usage(153_000, 69)))).toBeUndefined();
    expect(mode.read(snapshot(usage(153_000, 120, null), { backendKind: "codex" }))).toBeUndefined();
    expect(mode.read(snapshot(undefined))).toBeUndefined();
  });

  it("tells the composer once the 70 minutes pass", () => {
    vi.useFakeTimers({ now: NOW });
    const { mode } = setup();
    const listener = vi.fn();
    const stop = mode.subscribe(listener);
    expect(mode.read(snapshot(usage(153_000, 60)))).toBeUndefined();
    act(() => { vi.advanceTimersByTime(11 * MINUTE); });
    expect(listener).toHaveBeenCalled();
    expect(mode.read(snapshot(usage(153_000, 60)))).toBeDefined();
    stop();
  });

  it("stops for a runtime with “Always send with full history”, in the config every device reads", () => {
    const { mode, preferences } = setup({ now: () => NOW });
    const always = mode.read(snapshot(usage(153_000, 120)))!.options!.find((option) => option.id === "always-full-history")!;
    always.run!();
    expect(JSON.parse(preferences.value("tau.resume-compaction", "off") ?? "[]")).toEqual(["claude-code"]);
    expect(mode.read(snapshot(usage(153_000, 120)))).toBeUndefined();
    expect(mode.read(snapshot(usage(153_000, 120), { backendKind: "pi" }))).toBeDefined();
  });

  it("turns off for a runtime through its service, and Settings turns it back on", () => {
    const { registry, mode } = setup({ now: () => NOW });
    let service: ResumeCompactionOptOut | undefined;
    registry.activate({ id: "test.runtime", name: "Runtime", activate: (context) => context.useService<ResumeCompactionOptOut>(RESUME_COMPACTION_OPT_OUT_SERVICE, (value) => { service = value; }) });
    act(() => service!.turnOff("claude-code"));
    expect(mode.read(snapshot(usage(153_000, 120)))).toBeUndefined();

    const page = registry.getSettingsPages().find((entry) => entry.id === "resume-compaction.settings")!;
    expect(page.group).toBe("threads");
    const Page = page.Component;
    render(<WorkbenchShellContext.Provider value={{ snapshot: snapshot(undefined), registry }}><Page onNotify={vi.fn()} /></WorkbenchShellContext.Provider>);
    fireEvent.click(screen.getByRole("switch", { name: "Offer to compact Claude Code threads" }));
    expect(mode.read(snapshot(usage(153_000, 120)))).toBeDefined();
    expect(screen.getByText("Offered on every runtime")).toBeTruthy();
  });
});
