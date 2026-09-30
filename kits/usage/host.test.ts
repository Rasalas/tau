import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { assistantLine, claudeLine, codexMeta, codexResponse, DAY, writeSession } from "./fixtures.js";
import createUsageHostExtension, { LIMITS_MAX_AGE_MS, readBackendAnswer, readLimitsAnswer, readDays, readLogsAnswer, SCAN_MAX_AGE_MS } from "./host.js";
import type { UsageLimitsSummary, UsageSummary } from "./protocol.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const NOW = Date.UTC(2026, 8, 22, 12);
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.5, turns: 3 };

/** A backend kit that answers the usage command; `grant` says whether it named the Usage kit as a caller. */
function backendKit(id: string, grant: boolean, calls: { count: number }): HostExtension {
  return {
    id,
    name: id,
    activate(context) {
      context.registerCommand("usage", () => {
        calls.count += 1;
        return { threads: [{ threadId: `${id}-1`, cwd: "/work/alpha", model: "haiku", updatedAt: NOW - 1_000, usage }, { threadId: "broken" }] };
      }, grant ? { callers: ["tau.usage"] } : {});
    },
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "tau-usage-host-"));
  directories.push(root);
  const sessionsDir = join(root, "sessions");
  const observers: HostTurnObserver[] = [];
  let clock = NOW;
  await writeSession(sessionsDir, { id: "s1", cwd: "/work/alpha", createdAt: NOW - 2 * DAY, lines: [assistantLine({ id: "a1", at: NOW - 2 * DAY }), assistantLine({ id: "a2", at: NOW - 60_000 })] });
  const usageKit = createUsageHostExtension({ now: () => clock }) as unknown as HostExtension;
  const registry = await activateHostKit(usageKit, {
    sessionsDir,
    stateDir: join(root, "state"),
    registerTurnObserver: (observer: HostTurnObserver) => { observers.push(observer); return () => undefined; },
  } as never);
  const claudeCalls = { count: 0 };
  await registry.activate(backendKit("tau.claude-code", true, claudeCalls));
  await registry.activate(backendKit("tau.antigravity", false, { count: 0 }));
  const summary = (input?: unknown) => registry.invoke("tau.usage", "summary", input) as Promise<UsageSummary>;
  return { root, sessionsDir, registry, observers, claudeCalls, summary, advance: (ms: number) => { clock += ms; } };
}

describe("Usage host half", () => {
  it("sums Pi's sessions and the backend that granted it, and reports the one that did not", async () => {
    const { summary } = await harness();
    const all = await summary();
    expect(all.rows.map((row) => `${row.backend} ${row.projectName} ${row.model} ${row.requests}`).sort()).toEqual([
      "claude-code alpha haiku 3",
      "pi alpha anthropic/claude-haiku-4-5 2",
    ]);
    const antigravity = all.sources.find((source) => source.backend === "antigravity");
    expect(antigravity?.status).toBe("unavailable");
    expect(antigravity?.detail).toMatch(/^Not available: /u);

    const today = await summary({ since: NOW - DAY });
    expect(today.since).toBe(NOW - DAY);
    expect(today.rows.find((row) => row.backend === "pi")?.requests).toBe(1);
  });

  it("answers from its cache until a turn ends, the scan ages or a refresh is asked for", async () => {
    const { sessionsDir, observers, claudeCalls, summary, advance, root } = await harness();
    expect((await summary()).totals.threads).toBe(2);
    expect(claudeCalls.count).toBe(1);
    // The cache of per-file results lands in the kit's own state folder.
    expect(await readdir(join(root, "state", "tau.usage"))).toEqual(["pi-usage.json"]);

    await writeSession(sessionsDir, { id: "s2", cwd: "/work/beta", createdAt: NOW, lines: [assistantLine({ id: "b1", at: NOW })] });
    expect((await summary()).totals.threads).toBe(2);
    expect(claudeCalls.count).toBe(1);

    await observers[0]?.ended?.("s2", "turn-1", "completed");
    expect((await summary()).totals.threads).toBe(3);
    expect(claudeCalls.count).toBe(2);

    await summary({ refresh: true });
    expect(claudeCalls.count).toBe(3);

    advance(SCAN_MAX_AGE_MS + 1);
    await summary();
    expect(claudeCalls.count).toBe(4);
  });

  it("counts what the CLIs logged outside Tau, in the folders the kits name, and each Tau session once", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-usage-outside-host-"));
    directories.push(root);
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");
    const write = async (path: string, lines: string[]) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, `${lines.join("\n")}\n`); };
    await write(join(codexHome, "sessions", "2026", "09", "22", "rollout-a.jsonl"), [codexMeta("s-tau", "/work/alpha", NOW - 5_000), codexResponse(NOW - 4_000, "r-tau", { input: 900, output: 9 })]);
    await write(join(codexHome, "sessions", "2026", "09", "22", "rollout-b.jsonl"), [codexMeta("s-cli", "/work/side", NOW - 5_000), codexResponse(NOW - 4_000, "r-cli", { input: 30, output: 3 })]);
    await write(join(claudeHome, "projects", "-work-beta", "c-1.jsonl"), [claudeLine({ sessionId: "c-1", cwd: "/work/beta", at: NOW - 2_000, messageId: "m1", requestId: "q1", input: 10, output: 5 })]);
    const registry = await activateHostKit(createUsageHostExtension({ now: () => NOW, sources: [{ extensionId: "tau.codex", backend: "codex", label: "Codex" }], outsideWaitMs: 60_000 }) as unknown as HostExtension, {
      sessionsDir: join(root, "sessions"),
      stateDir: join(root, "state"),
      registerTurnObserver: () => () => undefined,
    } as never);
    await registry.activate({
      id: "tau.codex",
      name: "Codex",
      activate(context) {
        context.registerCommand("usage", () => ({ threads: [{ threadId: "tau-1", sessionId: "s-tau", cwd: "/work/alpha", updatedAt: NOW - 1_000, usage }] }), { callers: ["tau.usage"] });
        context.registerCommand("usage-logs", () => ({ folders: [
          { format: "codex", path: join(codexHome, "sessions"), instance: "codex", billing: "subscription" },
          { format: "codex", path: join(codexHome, "archived_sessions"), instance: "codex" },
        ] }), { callers: ["tau.usage"] });
      },
    });
    await registry.activate({
      id: "tau.claude-code",
      name: "Claude Code",
      activate(context) {
        context.registerCommand("usage-logs", () => ({ folders: [{ format: "agent-sdk", path: join(claudeHome, "projects"), instance: "claude-code" }, { format: "agent-sdk", path: "relative/projects", instance: "claude-code" }] }), { callers: ["tau.usage"] });
      },
    });
    const result = await registry.invoke("tau.usage", "summary", { days: [NOW - DAY, NOW - 10_000] }) as UsageSummary;
    expect(result.rows.map((row) => [row.backend, row.cwd, row.totalTokens, row.outside ?? false]).sort()).toEqual([
      ["claude-code", "/work/beta", 15, true],
      ["codex", "/work/alpha", 12, false],
      ["codex", "/work/side", 33, true],
    ]);
    expect(result.entries?.filter((entry) => entry.outside).map((entry) => entry.threadId).sort()).toEqual(["c-1", "s-cli"]);
    expect(result.sources.find((source) => source.backend === "opencode-outside")?.status).toBe("unavailable");
    expect(await readFile(join(root, "state", "tau.usage", "outside-usage.json"), "utf8")).not.toContain("never be kept");

    // After a first read, a summary answers with the last counts at once while a large new log is read.
    const lines = Array.from({ length: 60_000 }, (_, index) => codexResponse(NOW - 3_000, `r-big-${index}`, { input: 1, output: 0 }));
    await write(join(codexHome, "sessions", "2026", "09", "22", "rollout-c.jsonl"), [codexMeta("s-big", "/work/big", NOW - 5_000), ...lines]);
    const later = await registry.invoke("tau.usage", "summary", { refresh: true, days: [NOW - DAY, NOW - 15 * 60_000] }) as UsageSummary;
    expect(later.reading).toBe(true);
    expect(later.rows.some((row) => row.cwd === "/work/side")).toBe(true);
  });

  it("takes only absolute folders of a known layout from a kit", () => {
    expect(readLogsAnswer({ folders: [
      { format: "codex", path: "/home/codex/sessions", instance: "codex", billing: "subscription" },
      { format: "codex", path: "relative", instance: "codex" },
      { format: "pi", path: "/pi", instance: "pi" },
      { format: "agent-sdk", path: "/claude/projects", instance: "claude-code", billing: "gift" },
    ] })).toEqual([
      { format: "codex", path: "/home/codex/sessions", instance: "codex", billing: "subscription" },
      { format: "agent-sdk", path: "/claude/projects", instance: "claude-code" },
    ]);
    expect(readLogsAnswer({ folders: "no" })).toBeUndefined();
  });

  it("keeps only what has the agreed shape of another kit's answer", () => {
    expect(readBackendAnswer(undefined)).toBeUndefined();
    expect(readBackendAnswer({ threads: "no" })).toBeUndefined();
    expect(readBackendAnswer({ threads: [{ threadId: "t", cwd: "/w", updatedAt: 1, usage: { ...usage, turns: -1 } }, { threadId: 2 }] })).toEqual({
      threads: [{ threadId: "t", cwd: "/w", updatedAt: 1 }],
    });
  });

  it("prices its rows through core, a plan's value apart from the money", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-usage-price-"));
    directories.push(root);
    const sessionsDir = join(root, "sessions");
    await writeSession(sessionsDir, { id: "s1", cwd: "/work/alpha", createdAt: NOW - DAY, lines: [assistantLine({ id: "a1", at: NOW - 1_000, provider: "openai-codex", model: "gpt-5.6-luna", cost: 0 })] });
    const asked: unknown[] = [];
    const registry = await activateHostKit(createUsageHostExtension({ now: () => NOW, sources: [] }) as unknown as HostExtension, {
      sessionsDir,
      stateDir: join(root, "state"),
      registerTurnObserver: () => () => undefined,
      priceUsage: async (tallies: unknown[]) => { asked.push(...tallies); return tallies.map(() => ({ billing: "subscription", costUsd: 0, apiValueUsd: 0.12, source: "api" })); },
    } as never);
    const result = await registry.invoke("tau.usage", "summary") as UsageSummary;
    expect(asked).toEqual([expect.objectContaining({ provider: "openai-codex", model: "gpt-5.6-luna", totalTokens: 110, turns: 1 })]);
    expect(result.rows[0]).toMatchObject({ billing: "subscription", costUsd: 0, apiValueUsd: 0.12 });
    expect(result.totals).toMatchObject({ costUsd: 0, subscription: { apiValueUsd: 0.12, totalTokens: 110 } });

    // Split by the client's days, each entry is priced too. A day starts on a quarter hour, as every time zone's midnight does.
    asked.length = 0;
    const byDay = await registry.invoke("tau.usage", "summary", { since: NOW - DAY, days: [NOW - DAY, NOW - 15 * 60_000] }) as UsageSummary;
    expect(asked).toHaveLength(2);
    expect(byDay.entries).toEqual([expect.objectContaining({ day: 1, threadId: "s1", billing: "subscription", costUsd: 0, apiValueUsd: 0.12, totalTokens: 110 })]);
  });

  it("passes an account's identity on only as a hash, so an id sent by mistake never reaches the page", () => {
    const base = { id: "codex:account", runtime: "codex", label: "Codex", checkedAt: 1, windows: [] };
    const key = "0123456789abcdef".repeat(4);
    expect(readLimitsAnswer({ accounts: [
      { ...base, identity: { provider: "openai", key } },
      { ...base, identity: { provider: "openai", key: "acct-fixture-1" } },
      { ...base, identity: { provider: "Open AI", key } },
      { ...base, identity: "acct-fixture-1" },
    ] })?.map((account) => account.identity)).toEqual([{ provider: "openai", key }, undefined, undefined, undefined]);
  });

  it("takes only ascending day starts from a client", () => {
    expect(readDays([1, 2, 3])).toEqual([1, 2, 3]);
    expect(readDays([2, 1])).toBeUndefined();
    expect(readDays([1, "2"])).toBeUndefined();
    expect(readDays([])).toBeUndefined();
    expect(readDays(Array.from({ length: 400 }, (_, index) => index + 1))).toBeUndefined();
  });

  it("retains quota readings on failure and clears them on sign-out", async () => {
    const { registry } = await harness();
    let mode = "ok";
    await registry.activate({
      id: "tau.codex", name: "Codex",
      activate(context) {
        context.registerCommand("usage-limits", () => {
          if (mode === "failed") throw new Error("Provider offline");
          return { accounts: [{ id: "codex:account", runtime: "codex", label: "Codex", checkedAt: NOW, windows: mode === "ok" ? [{ id: "w", kind: "session", label: "5-hour", usedPercent: 30 }] : [], ...(mode === "signed-out" ? { unavailable: { reason: "signed-out" } } : {}) }] };
        }, { callers: ["tau.usage"] });
      },
    });
    const limits = () => registry.invoke("tau.usage", "limits", { refresh: true }) as Promise<UsageLimitsSummary>;
    expect((await limits()).history).toHaveLength(1);
    mode = "failed";
    const failed = await limits();
    expect(failed.accounts[0]).toMatchObject({ checkedAt: NOW, unavailable: { reason: "failed" }, windows: [{ usedPercent: 30 }] });
    expect(failed.history).toHaveLength(1);
    mode = "signed-out";
    expect((await limits()).history).toEqual([]);
    mode = "failed";
    expect((await limits()).accounts).toEqual([]);
  });

  it("asks every kit that reports limits, keeps what it answered a while, and says which could not be asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-usage-limits-"));
    directories.push(root);
    let clock = NOW;
    const registry = await activateHostKit(createUsageHostExtension({
      now: () => clock,
      sources: [],
      limitSources: [{ extensionId: "tau.codex", label: "Codex" }, { extensionId: "tau.pi-limits", label: "Pi" }],
    }) as unknown as HostExtension, { sessionsDir: join(root, "sessions"), stateDir: join(root, "state"), registerTurnObserver: () => () => undefined } as never);
    const calls: unknown[] = [];
    await registry.activate({
      id: "tau.codex",
      name: "Codex",
      activate(context) {
        context.registerCommand("usage-limits", (input) => {
          calls.push(input);
          return { accounts: [{ id: "codex:account", runtime: "codex", label: "Codex", plan: "pro", checkedAt: NOW, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 140, resetsAt: NOW + 1 }, { id: 2 }] }, { id: "broken" }] };
        }, { callers: ["tau.usage"] });
      },
    });
    const limits = (input?: unknown) => registry.invoke("tau.usage", "limits", input) as Promise<UsageLimitsSummary>;
    const first = await limits();
    expect(first.accounts).toEqual([{ id: "codex:account", runtime: "codex", label: "Codex", plan: "pro", checkedAt: NOW, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 100, resetsAt: NOW + 1 }] }]);
    expect(first.sources.map((source) => [source.label, source.status])).toEqual([["Codex", "ok"], ["Pi", "unavailable"]]);
    await limits();
    expect(calls).toEqual([{}]);
    await limits({ refresh: true });
    expect(calls).toEqual([{}, { refresh: true }]);
    clock += LIMITS_MAX_AGE_MS + 1;
    await limits();
    expect(calls).toHaveLength(3);
  });
});

it("keeps HTTPS usage management controls from a provider and rejects unsafe link schemes", () => {
  const account = { id: "plan", runtime: "codex", label: "ChatGPT plan", checkedAt: 1, windows: [] };
  expect(readLimitsAnswer({ accounts: [{ ...account, managementUrl: "https://chatgpt.com/settings/usage" }] })![0]!.managementUrl).toBe("https://chatgpt.com/settings/usage");
  expect(readLimitsAnswer({ accounts: [{ ...account, managementUrl: "javascript:alert(1)" }] })![0]!.managementUrl).toBeUndefined();
});
