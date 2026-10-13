import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UsageLimitAccount, UsageLimitWindow, UsageLimitsSummary } from "../../kits/usage/protocol";
import type { ExtensionUiPrompt } from "../../src/shared/contracts";
import { declareRuntimeMarks } from "../../src/renderer/runtime-marks";
import { BUNDLED_RUNTIME_MARKS } from "../../src/renderer/test-support/runtime-marks";
import { ThreadBoard, WIDGET_SNAPSHOT_VERSION, widgetSnapshot, widgetUsage } from "./widgets";

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
      ["Codex", "openai", "codex"], ["Claude Code", "anthropic", "claude-code"], ["OpenCode Go", "other", "opencode"],
    ]);
    expect(accounts[0]!.windows.map((entry) => [entry.label, entry.short, entry.usedPercent, entry.level])).toEqual([["5-hour", "5h", 34, undefined], ["Weekly", "wk", 91, "warn"]]);
    // A model's window stays out; a spent window is the fail level and reads as spent.
    expect(accounts[1]!.windows.map((entry) => [entry.short, entry.level, entry.pace])).toEqual([["5h", "fail", "spent"], ["wk", undefined, "on"]]);
    expect(accounts[2]!.windows[0]).toMatchObject({ short: "mo", usedPercent: 22 });
    expect(accounts[0]).toMatchObject({ plan: "ChatGPT Plus", poolKey: "openai:hashed-openai", checkedAt: NOW - 3 * MINUTE });
  });

  it("never carries account ids, and keeps an old reading for the widget to fade", () => {
    const accounts = widgetUsage(summary([codex, opencode]), NOW);
    const snapshot = widgetSnapshot("host-a", "Mac mini", NOW, accounts, []);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(snapshot.accounts?.map((account) => account.label)).toEqual(["Codex", "OpenCode Go"]);
    expect(snapshot).toMatchObject({ version: 4, hostId: "host-a", machine: "Mac mini", updatedAt: NOW, threads: [] });
    // Until the host answered, the snapshot carries no accounts, so the phone keeps the last ones.
    expect("accounts" in widgetSnapshot("host-a", "Mac mini", NOW, undefined, [])).toBe(false);
  });

  it("names a shared plan by its provider's plan mark and a Pi login by its provider", () => {
    const viaPi: UsageLimitAccount = { ...claude, id: "pi:anthropic", runtime: "pi", label: "Anthropic (Pi)", identity: { provider: "anthropic", key: "other" } };
    expect(widgetUsage(summary([viaPi]), NOW)[0]?.mark).toBe("claude-code");
    const shared = widgetUsage(summary([codex, { ...codex, id: "pi:openai-codex", runtime: "pi", label: "ChatGPT (Pi)" }]), NOW);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ label: "ChatGPT", mark: "codex" });
  });

  it("draws each runtime and provider as the desktop does, and a provider without a mark as its initials", () => {
    const account = (id: string, runtime: string): UsageLimitAccount => ({ id, runtime, label: runtime, checkedAt: NOW, windows: [window("monthly", "monthly", "Monthly", 20)] });
    const marks = (...accounts: UsageLimitAccount[]) => widgetUsage(summary(accounts), NOW).map(({ mark, initials }) => ({ mark, initials }));
    expect(marks(account("grok:default", "grok"), account("cursor:x", "cursor"), account("a:x", "antigravity"), account("c:x", "codex@work"))).toEqual(
      expect.arrayContaining([{ mark: "grok" }, { mark: "cursor" }, { mark: "antigravity" }, { mark: "codex" }]),
    );
    // A runtime named for its maker is the maker's plain mark; the plan is where Claude's spark and the knot appear.
    expect(marks(account("x:1", "anthropic"), account("x:2", "claude"))).toEqual([{ mark: "anthropic" }, { mark: "anthropic" }]);
    expect(marks(account("pi:xai", "pi"))).toEqual([{ mark: "grok" }]);
    expect(marks(account("pi:radius", "pi"))).toEqual([{ initials: "R" }]);
    expect(marks(account("pi:ant-ling", "pi"))).toEqual([{ initials: "AL" }]);
    expect(marks(account("acme:x", "acme"))).toEqual([{ initials: "A" }]);
  });
});

const PI = [{ mark: "pi" }];
const prompt = (id: string, sessionId: string, title: string): ExtensionUiPrompt => ({ id, sessionId, kind: "confirm", title });

describe("thread board", () => {
  it("lists threads that finished shortly before the app opened, and the reason of one that failed", () => {
    const board = new ThreadBoard(() => NOW);
    const session = (id: string, patch: object) => ({ id, title: `Thread ${id}`, path: "", projectPath: "", projectName: "tau", messageCount: 2, modifiedAt: NOW - 20 * MINUTE, ...patch });
    board.index({ sessions: [session("ok", {}), session("bad", { modifiedAt: NOW - 5 * MINUTE, turnError: "Rate limited" }), session("old", { modifiedAt: NOW - 5 * 60 * MINUTE }), session("empty", { messageCount: 0 })], runs: {} });
    expect(board.threads()).toEqual([
      { id: "bad", title: "Thread bad", project: "tau", state: "failed", endedAt: NOW - 5 * MINUTE, reason: "Rate limited", marks: [{ mark: "pi" }] },
      { id: "ok", title: "Thread ok", project: "tau", state: "done", endedAt: NOW - 20 * MINUTE, marks: [{ mark: "pi" }] },
    ]);
  });

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
      { id: "b", title: "Add pagination", project: "shop-api", state: "waiting", startedAt: NOW, askedAt: NOW + MINUTE, reason: "Wants to edit src/routes/orders.ts", marks: PI },
      { id: "a", title: "Fix flaky pairing test", project: "tau", state: "running", startedAt: NOW - 12 * MINUTE, marks: PI },
      { id: "c", title: "Nightly audit", project: "tau", state: "done", startedAt: NOW - 30 * MINUTE, endedAt: NOW + MINUTE, marks: PI },
    ]);
    board.apply({ type: "extension-ui-resolved", id: "p1", sessionId: "b" });
    expect(board.threads()[0]).toEqual({ id: "a", title: "Fix flaky pairing test", project: "tau", state: "running", startedAt: NOW - 12 * MINUTE, marks: PI });
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

describe("thread marks", () => {
  beforeAll(() => declareRuntimeMarks(BUNDLED_RUNTIME_MARKS));
  afterAll(() => declareRuntimeMarks([]));

  const usage = (total: number, subscription: number) => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: total, costUsd: 0, turns: 1,
    ...(subscription ? { subscription: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: subscription, turns: 1, apiValueUsd: 0 } } : {}) });
  const marksOf = (patch: object, declared = true) => {
    const board = new ThreadBoard(() => NOW);
    if (!declared) declareRuntimeMarks([]);
    board.index({ sessions: [{ id: "t", title: "Thread", path: "", projectPath: "", projectName: "tau", messageCount: 2, modifiedAt: NOW - MINUTE, ...patch }], runs: {} });
    if (!declared) declareRuntimeMarks(BUNDLED_RUNTIME_MARKS);
    return board.threads()[0]?.marks;
  };

  it("draws the stack the desktop's thread row draws: the runtime's mark, then the model provider's", () => {
    expect(marksOf({})).toEqual([{ mark: "pi" }]);
    expect(marksOf({ backendKind: "pi", modelProvider: "openai" })).toEqual([{ mark: "pi" }, { mark: "openai" }]);
    expect(marksOf({ backendKind: "pi", modelProvider: "google" })).toEqual([{ mark: "pi" }, { mark: "gemini" }]);
    expect(marksOf({ backendKind: "opencode", modelProvider: "anthropic" })).toEqual([{ mark: "opencode" }, { mark: "anthropic" }]);
  });

  it("gives a runtime with a provider of its own that mark alone, an instance like its program", () => {
    expect(marksOf({ backendKind: "codex", modelProvider: "openai" })).toEqual([{ mark: "codex" }]);
    expect(marksOf({ backendKind: "claude-code", modelProvider: "anthropic" })).toEqual([{ mark: "claude-code" }]);
    expect(marksOf({ backendKind: "codex@work", modelProvider: "openai" })).toEqual([{ mark: "codex" }]);
    expect(marksOf({ backendKind: "grok", modelProvider: "xai" })).toEqual([{ mark: "grok" }]);
  });

  it("draws a subscription as its product's mark: Claude's spark, OpenAI's knot", () => {
    expect(marksOf({ backendKind: "pi", modelProvider: "anthropic", usage: usage(100, 90) })).toEqual([{ mark: "pi" }, { mark: "claude-code" }]);
    expect(marksOf({ backendKind: "pi", modelProvider: "anthropic", usage: usage(100, 20) })).toEqual([{ mark: "pi" }, { mark: "anthropic" }]);
    expect(marksOf({ backendKind: "pi", modelProvider: "openai-codex" })).toEqual([{ mark: "pi" }, { mark: "codex" }]);
  });

  it("falls back to the desktop's initials for a provider without a mark", () => {
    expect(marksOf({ backendKind: "pi", modelProvider: "radius" })).toEqual([{ mark: "pi" }, { initials: "R" }]);
    expect(marksOf({ backendKind: "pi", modelProvider: "ant-ling" })).toEqual([{ mark: "pi" }, { initials: "AL" }]);
    expect(marksOf({ backendKind: "acme" })).toEqual([{ initials: "A" }]);
  });

  it("shows a thread taken over from another machine with that machine's runtime", () => {
    expect(marksOf({ backendKind: "pi", machine: { id: "m", name: "Mac mini", backendKind: "claude-code", modelProvider: "anthropic" } })).toEqual([{ mark: "claude-code" }]);
  });

  it("draws at write time, so runtimes declared after the index still count", () => {
    expect(marksOf({ backendKind: "codex", modelProvider: "openai" }, false)).toEqual([{ mark: "codex" }]);
    const board = new ThreadBoard(() => NOW);
    declareRuntimeMarks([]);
    board.index({ sessions: [{ id: "t", title: "Thread", path: "", projectPath: "", projectName: "tau", messageCount: 2, modifiedAt: NOW, backendKind: "codex", modelProvider: "openai" }], runs: {} });
    expect(board.threads()[0]?.marks).toEqual([{ mark: "codex" }, { mark: "openai" }]);
    declareRuntimeMarks(BUNDLED_RUNTIME_MARKS);
    expect(board.threads()[0]?.marks).toEqual([{ mark: "codex" }]);
  });

  it("has none for a thread the index never listed", () => {
    const board = new ThreadBoard(() => NOW);
    board.apply({ type: "agent-status", sessionId: "unknown", running: true });
    expect(board.threads()[0]).not.toHaveProperty("marks");
  });
});

describe("snapshot version", () => {
  // Both native readers refuse a snapshot of another version, so a bump on one side alone blanks every widget.
  const native = (path: string, pattern: RegExp) => Number(pattern.exec(readFileSync(new URL(path, import.meta.url), "utf8"))?.[1]);
  it("is the one the iOS and Android readers expect", () => {
    expect(native("../plugins/tau-native/ios/Sources/TauNativePlugin/WidgetModel.swift", /static let wireVersion = (\d+)/u)).toBe(WIDGET_SNAPSHOT_VERSION);
    expect(native("../plugins/tau-native/android/src/main/java/de/tbuck/tau/plugin/widgets/WidgetModel.kt", /const val WIRE_VERSION = (\d+)/u)).toBe(WIDGET_SNAPSHOT_VERSION);
  });
});
