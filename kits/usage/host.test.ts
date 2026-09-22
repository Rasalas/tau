import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { assistantLine, DAY, writeSession } from "./fixtures.js";
import createUsageHostExtension, { readBackendAnswer, SCAN_MAX_AGE_MS } from "./host.js";
import type { UsageSummary } from "./protocol.js";

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

  it("keeps only what has the agreed shape of another kit's answer", () => {
    expect(readBackendAnswer(undefined)).toBeUndefined();
    expect(readBackendAnswer({ threads: "no" })).toBeUndefined();
    expect(readBackendAnswer({ threads: [{ threadId: "t", cwd: "/w", updatedAt: 1, usage: { ...usage, turns: -1 } }, { threadId: 2 }] })).toEqual({
      threads: [{ threadId: "t", cwd: "/w", updatedAt: 1 }],
    });
  });
});
