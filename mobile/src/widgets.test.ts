import { describe, expect, it } from "vitest";
import type { UsageLimitAccount, UsageLimitWindow, UsageLimitsSummary } from "../../kits/usage/protocol";
import type { ExtensionUiPrompt } from "../../src/shared/contracts";
import { ThreadBoard, usageSnapshot, widgetUsage } from "./widgets";

const NOW = new Date(2026, 9, 1, 14, 2).getTime();
const MINUTE = 60_000;
const window = (id: string, kind: UsageLimitWindow["kind"], label: string, usedPercent: number, patch: Partial<UsageLimitWindow> = {}): UsageLimitWindow =>
  ({ id, kind, label, usedPercent, windowMinutes: kind === "session" ? 300 : kind === "weekly" ? 10_080 : 43_200, resetsAt: NOW + 2 * 60 * MINUTE, ...patch });
const codex: UsageLimitAccount = { id: "codex:secret-account", runtime: "codex", label: "Codex", plan: "ChatGPT Plus", checkedAt: NOW - 3 * MINUTE, identity: { provider: "openai", key: "hashed-openai" },
  windows: [window("primary", "session", "5-hour", 34), window("secondary", "weekly", "Weekly", 91)] };
const claude: UsageLimitAccount = { id: "claude-code:secret", runtime: "claude-code", label: "Claude Code", plan: "Max", checkedAt: NOW - MINUTE, identity: { provider: "anthropic", key: "hashed-anthropic" },
  windows: [window("seven_day_fable", "weekly", "Weekly · Fable", 10), window("seven_day", "weekly", "Weekly", 47), window("five_hour", "session", "5-hour", 100)] };
const opencode: UsageLimitAccount = { id: "opencode-go:x", runtime: "opencode-go", label: "OpenCode Go", checkedAt: NOW - 40 * MINUTE, windows: [window("monthly", "monthly", "Monthly", 22)] };
const signedOut: UsageLimitAccount = { id: "grok:x", runtime: "grok", label: "Grok", checkedAt: NOW, windows: [], unavailable: { reason: "signed-out" } };
const summary = (accounts: UsageLimitAccount[]): UsageLimitsSummary => ({ checkedAt: NOW, accounts, sources: [] });

describe("Plan limits snapshot", () => {
  it("keeps the sidebar's fixed account order and default windows, with marks, short labels and levels", () => {
    const accounts = widgetUsage(summary([opencode, claude, signedOut, codex]), NOW);
    expect(accounts.map((account) => [account.label, account.tone, account.mark])).toEqual([
      ["Codex", "openai", "mark-codex"], ["Claude Code", "anthropic", "mark-claude-code"], ["OpenCode Go", "other", "mark-opencode"],
    ]);
    expect(accounts[0]!.windows.map((entry) => [entry.label, entry.short, entry.usedPercent, entry.level])).toEqual([["5-hour", "5h", 34, undefined], ["Weekly", "wk", 91, "warn"]]);
    // A model's window stays out; a spent window is the fail level and reads as spent.
    expect(accounts[1]!.windows.map((entry) => [entry.short, entry.level, entry.pace])).toEqual([["5h", "fail", "spent"], ["wk", undefined, "on"]]);
    expect(accounts[2]!.windows[0]).toMatchObject({ short: "mo", usedPercent: 22 });
    expect(accounts[0]).toMatchObject({ plan: "ChatGPT Plus", poolKey: "openai:hashed-openai", checkedAt: NOW - 3 * MINUTE });
  });

  it("never carries account ids, and keeps an old reading for the widget to fade", () => {
    const snapshot = usageSnapshot("host-a", "Mac mini", summary([codex, opencode]), NOW);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(snapshot.accounts.map((account) => account.label)).toEqual(["Codex", "OpenCode Go"]);
    // Android's card drops a snapshot at expiresAt: only the fresh reading decides it.
    expect(snapshot.expiresAt).toBe(NOW - 3 * MINUTE + 15 * MINUTE);
    expect(usageSnapshot("host-a", "Mac mini", summary([opencode]), NOW).expiresAt).toBe(NOW);
    expect(snapshot).toMatchObject({ version: 2, hostId: "host-a", machine: "Mac mini", updatedAt: NOW });
  });

  it("names a shared plan by its provider's plan mark and a Pi login by its provider", () => {
    const viaPi: UsageLimitAccount = { ...claude, id: "pi:anthropic", runtime: "pi", label: "Anthropic (Pi)", identity: { provider: "anthropic", key: "other" } };
    expect(widgetUsage(summary([viaPi]), NOW)[0]?.mark).toBe("mark-claude-code");
    const shared = widgetUsage(summary([codex, { ...codex, id: "pi:openai-codex", runtime: "pi", label: "ChatGPT (Pi)" }]), NOW);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ label: "ChatGPT", mark: "mark-codex" });
  });
});

const prompt = (id: string, sessionId: string, title: string): ExtensionUiPrompt => ({ id, sessionId, kind: "confirm", title });

describe("thread board", () => {
  it("orders a question first, then running threads by start, then ended ones newest first", () => {
    let now = NOW;
    const board = new ThreadBoard(() => now);
    board.index({ sessions: [
      { id: "a", title: "Fix flaky pairing test", projectName: "tau" },
      { id: "b", title: "Add pagination", projectName: "shop-api" },
      { id: "c", title: "Nightly audit", projectName: "tau" },
      { id: "child", title: "Index 1", projectName: "tau", parentThreadId: "a" },
    ].map((session) => ({ path: "", modifiedAt: 0, projectPath: "", messageCount: 1, ...session })), runs: { a: NOW - 12 * MINUTE } });
    board.apply({ type: "agent-status", sessionId: "c", running: true, startedAt: NOW - 30 * MINUTE });
    board.apply({ type: "agent-status", sessionId: "child", running: true });
    now += MINUTE;
    board.apply({ type: "agent-status", sessionId: "c", running: false });
    board.apply({ type: "agent-status", sessionId: "b", running: true, startedAt: NOW });
    board.apply({ type: "extension-ui-prompt", sessionId: "b", prompt: prompt("p1", "b", "Wants to edit src/routes/orders.ts") });
    expect(board.threads()).toEqual([
      { id: "b", title: "Add pagination", project: "shop-api", state: "waiting", startedAt: NOW, askedAt: NOW + MINUTE, reason: "Wants to edit src/routes/orders.ts" },
      { id: "a", title: "Fix flaky pairing test", project: "tau", state: "running", startedAt: NOW - 12 * MINUTE },
      { id: "c", title: "Nightly audit", project: "tau", state: "done", startedAt: NOW - 30 * MINUTE, endedAt: NOW + MINUTE },
    ]);
    board.apply({ type: "extension-ui-resolved", id: "p1", sessionId: "b" });
    expect(board.threads()[0]).toEqual({ id: "a", title: "Fix flaky pairing test", project: "tau", state: "running", startedAt: NOW - 12 * MINUTE });
    expect(board.threads()[1]).toMatchObject({ id: "b", state: "running" });
  });

  it("marks a turn that failed with its reason, ignores the end of a run it never saw and forgets ended threads after a day", () => {
    let now = NOW;
    const board = new ThreadBoard(() => now);
    expect(board.apply({ type: "agent-status", sessionId: "x", running: false })).toBe(false);
    board.apply({ type: "agent-status", sessionId: "r", running: true });
    board.apply({ type: "error", sessionId: "r", message: "Rate limited · Codex 5-hour" });
    expect(board.threads()[0]).toEqual({ id: "r", title: "Agent work", state: "running", startedAt: NOW });
    board.apply({ type: "agent-status", sessionId: "r", running: false });
    expect(board.threads()).toEqual([{ id: "r", title: "Agent work", state: "failed", startedAt: NOW, endedAt: NOW, reason: "Rate limited · Codex 5-hour" }]);
    board.apply({ type: "agent-status", sessionId: "r", running: true });
    expect(board.threads()[0]).toEqual({ id: "r", title: "Agent work", state: "running", startedAt: NOW });
    board.apply({ type: "agent-status", sessionId: "r", running: false });
    now += 25 * 60 * MINUTE;
    expect(board.threads()).toEqual([]);
  });
});
