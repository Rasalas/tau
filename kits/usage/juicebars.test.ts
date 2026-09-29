import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { choiceKey, createJuicebarChoices, juicebarGroups, shownByDefault } from "./juicebars.js";
import { groupAccounts } from "./accounts.js";
import { mergeLimits } from "./machines.js";
import type { UsageLimitAccount, UsageLimitWindow, UsageLimitsSummary } from "./protocol.js";

afterEach(() => { setClientStorage(undefined); });

const NOW = new Date(2026, 8, 29, 11, 0).getTime();
const HOUR = 3_600_000;

function window(id: string, kind: UsageLimitWindow["kind"], label: string, usedPercent: number, overrides: Partial<UsageLimitWindow> = {}): UsageLimitWindow {
  return { id, kind, label, usedPercent, windowMinutes: kind === "session" ? 300 : 10_080, resetsAt: NOW + 2 * HOUR, ...overrides };
}

const claude: UsageLimitAccount = {
  id: "claude-code:account", runtime: "claude-code", label: "Claude Code", plan: "max", checkedAt: NOW - 60_000,
  identity: { provider: "anthropic", key: "k-anthropic" },
  windows: [
    window("seven_day_fable", "weekly", "Weekly · Fable", 20),
    window("seven_day", "weekly", "Weekly", 41),
    window("five_hour", "session", "5-hour", 95),
  ],
};
const codex: UsageLimitAccount = {
  id: "codex:account", runtime: "codex", label: "Codex", checkedAt: NOW - 60_000, identity: { provider: "openai", key: "k-openai" },
  windows: [window("primary", "session", "5-hour", 100), window("secondary", "weekly", "Weekly", 30)],
};
const apiKey: UsageLimitAccount = { id: "claude-code@work:account", runtime: "claude-code@work", label: "Claude Code (work)", checkedAt: NOW, windows: [], unavailable: { reason: "unsupported" } };
const grok: UsageLimitAccount = { id: "grok:account", runtime: "grok", label: "Grok", checkedAt: NOW - 30 * 60_000, windows: [window("subscription", "monthly", "Monthly", 50, { windowMinutes: 43_200 })] };

const summary = (accounts: UsageLimitAccount[]): UsageLimitsSummary => ({ checkedAt: NOW, accounts, sources: [] });

describe("juicebars", () => {
  it("shows the 5-hour and weekly windows of each plan by default, never a model's, and a monthly plan's only window", () => {
    expect(claude.windows.map((entry) => shownByDefault(entry, claude.windows))).toEqual([false, true, true]);
    expect(shownByDefault(grok.windows[0]!, grok.windows)).toBe(true);
    const groups = juicebarGroups(summary([claude, apiKey, grok, codex]), {}, NOW);
    // Providers in a fixed order; an API key's account has no bar.
    expect(groups.map((entry) => [entry.tone, entry.bars.map((bar) => `${bar.window.label} ${bar.left}`)])).toEqual([
      ["openai", ["5-hour 0", "Weekly 70"]],
      ["anthropic", ["5-hour 5", "Weekly 59"]],
      ["other", ["Monthly 50"]],
    ]);
  });

  it("colours a spent window as failed, a low one as a warning, an old reading as stale", () => {
    const [openai, anthropic, other] = juicebarGroups(summary([claude, codex, grok]), {}, NOW);
    expect(openai!.bars.map((bar) => bar.level)).toEqual(["fail", undefined]);
    expect(anthropic!.bars.map((bar) => bar.level)).toEqual(["warn", undefined]);
    expect(other!.bars.map((bar) => bar.level)).toEqual(["stale"]);
    // Past its reset a window says nothing about now.
    const reset = { ...codex, windows: [window("secondary", "weekly", "Weekly", 30, { resetsAt: NOW - HOUR })] };
    expect(juicebarGroups(summary([reset]), {}, NOW)[0]!.bars[0]!.level).toBe("stale");
  });

  it("follows the user's choice per window, and draws nothing for an account with all of them off", () => {
    const group = groupAccounts([claude])[0]!;
    const choices = {
      [choiceKey(group, claude.windows[0]!)]: true,
      [choiceKey(group, claude.windows[2]!)]: false,
    };
    expect(juicebarGroups(summary([claude]), choices, NOW)[0]!.bars.map((bar) => bar.window.label)).toEqual(["Weekly", "Weekly · Fable"]);
    const off = { ...choices, [choiceKey(group, claude.windows[1]!)]: false, [choiceKey(group, claude.windows[0]!)]: false };
    expect(juicebarGroups(summary([claude]), off, NOW)).toEqual([]);
  });

  it("draws one account once across machines and runtimes, and keeps the choice for it", () => {
    const onRex = { ...claude, checkedAt: NOW - 30_000, windows: claude.windows.map((entry) => ({ ...entry, usedPercent: entry.usedPercent + 1 })) };
    const pi: UsageLimitAccount = { id: "pi:anthropic", runtime: "pi", label: "Pi · anthropic", checkedAt: NOW - 90_000, identity: claude.identity!, windows: [window("five_hour", "session", "5-hour", 90)] };
    const merged = mergeLimits(summary([claude, pi]), [{ machine: { id: "rex-id", name: "rex" }, limits: summary([onRex]) }]);
    const groups = juicebarGroups(merged, {}, NOW);
    expect(groups).toHaveLength(1);
    // The freshest reading draws the bars: rex's.
    expect(groups[0]!.bars.map((bar) => bar.left)).toEqual([4, 58]);
    expect(choiceKey(groups[0]!.group, claude.windows[1]!)).toBe("anthropic:k-anthropic|seven_day");
  });

  it("keeps the choices on this device", () => {
    const storage = createMemoryStorage();
    setClientStorage(storage);
    const choices = createJuicebarChoices();
    let told = 0;
    choices.subscribe(() => { told += 1; });
    choices.set("anthropic:k|seven_day_fable", true);
    expect(told).toBe(1);
    expect(createJuicebarChoices().getSnapshot()).toEqual({ "anthropic:k|seven_day_fable": true });
  });
});
