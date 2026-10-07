import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { HostMcpInstructionsProvider, HostSessionServices, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import type { SourceControl } from "./provider-registry.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { registerPullRequestWatches } from "./pr-watch-host.js";
import { readWatchSnapshot } from "./pr-watch-github.js";
import { watchChanges, type WatchSnapshot, type WatchState } from "./pr-watch-protocol.js";
const URL = "https://github.com/example/project/pull/42";
const initial: WatchSnapshot = { state: "OPEN", head: "head-1", checks: "PENDING", comments: "0", conflict: false };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function harness(directory?: string, current = initial) {
  const stateDir = directory ?? await mkdtemp(join(tmpdir(), "tau-pr-watch-"));
  if (!directory) cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  let snapshot = current, time = Date.now(), failure = false, observer: HostTurnObserver | undefined;
  const instructions: HostMcpInstructionsProvider[] = [];
  const promptHooks: ((event: { systemPrompt: string }) => { systemPrompt: string })[] = [];
  const read = vi.fn(async () => { if (failure) throw new Error("GitHub unavailable"); return structuredClone(snapshot); });
  const send = vi.fn(async (_id: string, _text: string, _options: unknown) => {
    // The durable fingerprint precedes the visible queue admission.
    const stored = JSON.parse(await readFile(join(stateDir, "tau.review", "pr-watches.json"), "utf8"));
    expect(JSON.stringify(stored)).toContain(snapshot.comments);
  });
  const registry = await activateHostKit({ id: "tau.review", name: "Review", permissions: ["sessions", "runtime:extend"], activate: (context) => registerPullRequestWatches(context, { tools: {}, forUrl: (url: string) => ({ ref: parseRequestUrl(url) }) } as unknown as SourceControl, { link: async () => undefined, review: async () => undefined, dispose: () => undefined }, { period: 15, read, now: () => time }) }, {
    stateDir, sessions: { list: async () => [{ sessionId: "a" }, { sessionId: "b" }], refreshIndex: async () => ({ type: "thread-index", index: { projects: [], sessions: ["a", "b", "claude-1"].map((id) => ({ id })) } }), send } as unknown as HostSessionServices,
    registerTurnObserver: (value) => { observer = value; return () => { observer = undefined; }; },
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, registerInstructions: (provider) => { instructions.push(provider); return () => undefined; }, connect: async () => undefined },
    registerRuntimeExtension: (_name, setup) => {
      (setup as (pi: unknown, session: unknown) => void)({ registerTool: () => undefined, on: (event: string, hook: (typeof promptHooks)[number]) => { if (event === "before_agent_start") promptHooks.push(hook); } }, { sessionId: "a", cwd: "/project" });
      return () => undefined;
    },
  });
  cleanups.push(() => registry.deactivate("tau.review"));
  const call = (command: string, input?: unknown) => registry.invoke("tau.review", command, input);
  return { stateDir, registry, call, instructions, promptHooks, send, read, stop: (id: string) => observer?.stopped?.(id), list: () => call("watch-list") as Promise<WatchState>, change: (value: Partial<WatchSnapshot>) => { snapshot = { ...snapshot, ...value }; }, unavailable: () => { failure = true; time += 16 * 60_000; } };
}
it("detects checks finishing on a new head, comments, new conflicts and terminal state without waking on ordinary polling", () => {
  expect(watchChanges(initial, initial)).toEqual([]);
  expect(watchChanges(initial, { ...initial, checks: "SUCCESS", comments: "1", conflict: true })).toEqual(["checks finished", "new comments or reviews", "branch conflicts"]);
  expect(watchChanges({ ...initial, checks: "SUCCESS" }, { ...initial, checks: "SUCCESS", head: "head-2" })).toEqual(["checks finished"]);
  expect(watchChanges(initial, { ...initial, state: "MERGED" })).toEqual(["merged"]);
});
it("queues marked deduplicated wakes, persists before admission, survives restart, and Stop ends every watch", async () => {
  const h = await harness();
  await h.call("watch-start", { threadId: "a", url: URL });
  h.change({ checks: "SUCCESS" });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(h.send).toHaveBeenCalledWith("a", expect.stringContaining("checks finished"), { delivery: "queue", wake: { source: "pull-request", label: "PR #42 · checks finished" } });
  await h.registry.deactivate("tau.review");
  const restored = await harness(h.stateDir, { ...initial, checks: "SUCCESS" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(restored.send).not.toHaveBeenCalled();
  expect((await restored.list()).watches[0]?.wakes).toBe(1);
  expect(await restored.stop("a")).toEqual(["stopped watching PR #42"]);
  restored.change({ comments: "new" });
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(restored.send).not.toHaveBeenCalled();
});
it("shares a polling read across threads and restores only watches stopped by Settle", async () => {
  const h = await harness();
  for (const threadId of ["a", "b"]) await h.call("watch-start", { threadId, url: URL });
  h.read.mockClear(); h.change({ comments: "1" });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
  const before = h.read.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 32));
  expect(h.read.mock.calls.length - before).toBeLessThanOrEqual(3);
  await h.call("watch-shelf", { settled: ["a"] });
  await h.stop("b");
  await h.call("watch-shelf", { restored: ["a", "b"] });
  expect((await h.list()).watches.map((watch) => [watch.threadId, watch.status])).toEqual([["a", "watching"], ["b", "ended"]]);
});
it("ends after fifteen minutes unreadable", async () => {
  const h = await harness();
  await h.call("watch-start", { threadId: "a", url: URL });
  h.unavailable();
  await vi.waitFor(async () => expect((await h.list()).watches[0]?.status).toBe("ended"));
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.send.mock.calls[0]?.[1]).toContain("unreadable for 15 minutes");
});
it("reads one compact GitHub query and refuses incomplete review-thread coverage", async () => {
  const cli = vi.fn(async () => JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", mergeable: "CONFLICTING", headRefOid: "head", comments: { totalCount: 1 }, reviews: {}, reviewThreads: { pageInfo: { hasPreviousPage: false } }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } } } } }));
  const tools = { cli, cached: (_kind: string, _ref: unknown, _fresh: boolean, read: () => unknown) => read() } as never;
  expect(await readWatchSnapshot(tools, parseRequestUrl(URL)!)).toMatchObject({ state: "OPEN", checks: "SUCCESS", conflict: true });
  expect(cli).toHaveBeenCalledTimes(1);
  expect(cli.mock.calls[0]).toBeDefined();
  cli.mockResolvedValueOnce(JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", headRefOid: "head", reviewThreads: { pageInfo: { hasPreviousPage: true } } } } } }));
  await expect(readWatchSnapshot(tools, parseRequestUrl(URL)!)).rejects.toThrow("more than 100");
});

it("ends after ten consecutive comment wakes and sends the stopping reason with the final wake", async () => {
  const h = await harness();
  await h.call("watch-start", { threadId: "a", url: URL });
  for (let count = 1; count <= 10; count++) {
    h.change({ comments: String(count) });
    // oxlint-disable-next-line no-await-in-loop -- each distinct provider event follows the previous admission.
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(count));
  }
  expect((await h.list()).watches[0]).toMatchObject({ status: "ended", wakes: 10, commentStreak: 10 });
  expect(h.send.mock.calls[9]?.[1]).toContain("watch ended after ten comment wakes");
});
it("tells every runtime to wait on a pull request with a watch rather than a polling loop", async () => {
  const h = await harness();
  const mcp = h.instructions.map((provider) => provider({ sessionId: "a", cwd: "/project" })).join("\n");
  const pi = h.promptHooks.reduce((event, hook) => hook(event), { systemPrompt: "base" }).systemPrompt;
  for (const text of [mcp, pi]) {
    expect(text).toContain("<pull_request_watching>");
    expect(text).toMatch(/watch_pull_request/u);
  }
  expect(pi.startsWith("base\n\n")).toBe(true);
});
it("watches a thread of any runtime, not only Pi's, and refuses one the host does not know", async () => {
  const h = await harness();
  await h.call("watch-start", { threadId: "claude-1", url: URL });
  expect((await h.list()).watches.map((watch) => watch.threadId)).toEqual(["claude-1"]);
  await expect(h.call("watch-start", { threadId: "gone", url: URL })).rejects.toThrow("The thread no longer exists.");
});
