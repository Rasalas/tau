import { describe, expect, it } from "vitest";
import type { UsageLimitAccount } from "../../kits/usage/protocol";
import { MAX_THREADS, widgetAccounts, widgetThreads, type WidgetThread } from "./widget-snapshot";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const account = (patch: Partial<UsageLimitAccount>): UsageLimitAccount => ({ id: "a", runtime: "codex", label: "Codex", checkedAt: NOW, windows: [], ...patch });

describe("widget accounts", () => {
  it("orders accounts as the juicebars do and keeps their default windows, short first", () => {
    const result = widgetAccounts([
      account({ id: "oc", runtime: "opencode", label: "OpenCode Go", windows: [{ id: "m", kind: "monthly", label: "Monthly", usedPercent: 22 }] }),
      account({ id: "cc", runtime: "claude-code", label: "Claude Code", plan: "Max", windows: [
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 47 },
        { id: "model.opus", kind: "weekly", label: "Weekly · Opus", usedPercent: 10 },
        { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 12, windowMinutes: 300, resetsAt: NOW + 70 * MIN },
      ] }),
      account({ id: "cx", plan: "ChatGPT Plus", windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 34, windowMinutes: 300 }, { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 91 }] }),
    ], NOW);
    expect(result.map((entry) => [entry.label, entry.tone, entry.mark, entry.plan])).toEqual([
      ["Codex", "openai", "codex", "ChatGPT Plus"], ["Claude Code", "anthropic", "claude-code", "Max"], ["OpenCode Go", "other", "opencode", undefined],
    ]);
    expect(result[1]!.windows).toEqual([{ label: "5-hour", short: "5h", usedPercent: 12, resetsAt: NOW + 70 * MIN }, { label: "Weekly", short: "wk", usedPercent: 47 }]);
    expect(result[2]!.windows[0]!.short).toBe("mo");
  });

  it("keeps old readings only when asked, for the widgets to draw faded", () => {
    const old = [account({ checkedAt: NOW - 2 * 60 * MIN, windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 91 }] })];
    expect(widgetAccounts(old, NOW)).toEqual([]);
    expect(widgetAccounts(old, NOW, true)[0]!.windows[0]!.usedPercent).toBe(91);
  });

  it("gives a Pi account its provider's mark and colour", () => {
    const [pi] = widgetAccounts([account({ id: "pi:anthropic", runtime: "pi", label: "Anthropic", windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 5 }] })], NOW);
    expect([pi!.tone, pi!.mark]).toEqual(["anthropic", "claude-code"]);
  });
});

describe("widget threads", () => {
  const thread = (id: string, state: WidgetThread["state"], since: number): WidgetThread => ({ id, title: `Thread ${id}`, state, since, updatedAt: NOW });
  it("puts questions first, then the longest runs, then the latest finished, and drops old finished ones", () => {
    const result = widgetThreads([thread("done", "done", NOW - 6 * MIN), thread("short", "running", NOW - 3 * MIN), thread("old", "done", NOW - 4 * 60 * MIN), thread("long", "running", NOW - 12 * MIN), thread("ask", "question", NOW - 4 * MIN), thread("failed", "failed", NOW - 20 * MIN)], NOW);
    expect(result.map((entry) => entry.id)).toEqual(["ask", "long", "short", "done", "failed"]);
  });
  it("caps the list", () => {
    expect(widgetThreads(Array.from({ length: 20 }, (_, index) => thread(`t${index}`, "running", NOW - index)), NOW)).toHaveLength(MAX_THREADS);
  });
});
