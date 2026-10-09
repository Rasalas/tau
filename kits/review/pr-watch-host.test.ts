import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { HostMcpInstructionsProvider, HostSessionServices, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import type { SourceControl } from "./provider-registry.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { registerPullRequestWatches, wakeText } from "./pr-watch-host.js";
import { readWatchSnapshot } from "./pr-watch-github.js";
import { watchChanges, type PullRequestWatch, type WatchSnapshot, type WatchState } from "./pr-watch-protocol.js";
const URL = "https://github.com/example/project/pull/42";
const initial: WatchSnapshot = { state: "OPEN", head: "head-1", checks: "pending", failed: [], comments: "0", conflict: false };
const cleanups: (() => Promise<unknown>)[] = [];
const wakeLabel = (send: { mock: { calls: unknown[][] } }, index: number) => (send.mock.calls[index]?.[2] as { wake?: { label?: string } } | undefined)?.wake?.label;
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function harness(directory?: string, current = initial) {
  const stateDir = directory ?? await mkdtemp(join(tmpdir(), "tau-pr-watch-"));
  if (!directory) cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  let snapshot = current, time = Date.now(), failure = false, observer: HostTurnObserver | undefined;
  const instructions: HostMcpInstructionsProvider[] = [];
  const promptHooks: ((event: { systemPrompt: string }) => { systemPrompt: string })[] = [];
  const read = vi.fn(async () => { if (failure) throw new Error("GitHub unavailable"); return structuredClone(snapshot); });
  const reread = vi.fn(async (_url: string) => undefined);
  const send = vi.fn(async (_id: string, _text: string, _options: unknown) => {
    // The durable fingerprint precedes the visible queue admission.
    const stored = JSON.parse(await readFile(join(stateDir, "tau.review", "pr-watches.json"), "utf8"));
    expect(JSON.stringify(stored)).toContain(snapshot.comments);
  });
  const registry = await activateHostKit({ id: "tau.review", name: "Review", permissions: ["sessions", "runtime:extend"], activate: (context) => registerPullRequestWatches(context, { tools: {}, forUrl: (url: string) => ({ ref: parseRequestUrl(url) }) } as unknown as SourceControl, { link: async () => undefined, review: async () => undefined, observe: async () => undefined, reread, dispose: () => undefined }, { period: 15, read, now: () => time }) }, {
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
  return { stateDir, registry, call, instructions, promptHooks, send, read, reread, stop: (id: string) => observer?.stopped?.(id), list: () => call("watch-list") as Promise<WatchState>, change: (value: Partial<WatchSnapshot>) => { snapshot = { ...snapshot, ...value }; }, unavailable: () => { failure = true; time += 16 * 60_000; } };
}
it("detects checks finishing on a new head, comments, new conflicts and terminal state without waking on ordinary polling", () => {
  expect(watchChanges(initial, initial)).toEqual([]);
  expect(watchChanges(initial, { ...initial, checks: "done", comments: "1", conflict: true })).toEqual(["checks finished", "new comments or reviews", "branch conflicts"]);
  expect(watchChanges({ ...initial, checks: "done" }, { ...initial, checks: "done", head: "head-2" })).toEqual(["checks finished"]);
  expect(watchChanges(initial, { ...initial, state: "MERGED" })).toEqual(["merged"]);
});
it("wakes once when every check is done, at once for each new failure, and judges a new head afresh", () => {
  const smoke = { id: "7", name: "smoke" }, test = { id: "8", name: "test (1/3)" };
  expect(watchChanges(initial, { ...initial })).toEqual([]);
  expect(watchChanges(initial, { ...initial, failed: [smoke] })).toEqual(["a check failed (smoke)"]);
  expect(watchChanges({ ...initial, failed: [smoke] }, { ...initial, failed: [smoke] })).toEqual([]);
  expect(watchChanges({ ...initial, failed: [smoke] }, { ...initial, checks: "done", failed: [smoke] })).toEqual(["checks finished"]);
  expect(watchChanges({ ...initial, failed: [smoke] }, { ...initial, failed: [smoke, test] })).toEqual(["a check failed (test (1/3))"]);
  expect(watchChanges(initial, { ...initial, checks: "done", failed: [smoke, test] })).toEqual(["checks finished", "2 checks failed (smoke, test (1/3))"]);
  expect(watchChanges({ ...initial, checks: "done", failed: [smoke] }, { ...initial, head: "head-2", failed: [smoke] })).toEqual(["a check failed (smoke)"]);
  expect(watchChanges({ ...initial, checks: "done" }, { ...initial, head: "head-2", checks: "none" })).toEqual([]);
  expect(watchChanges({ ...initial, checks: "none" }, { ...initial, checks: "none" })).toEqual([]);
  // A baseline from before failures were tracked adopts the current ones silently.
  expect(watchChanges({ ...initial, failed: undefined }, { ...initial, failed: [smoke] })).toEqual([]);
});
it("stays quiet while checks pass one by one, wakes on each failure, then once when the last check finishes", async () => {
  const h = await harness();
  await h.call("watch-start", { threadId: "a", url: URL });
  const label = (index: number) => wakeLabel(h.send, index);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(h.send).not.toHaveBeenCalled();
  h.change({ failed: [{ id: "1", name: "wayland-native" }] });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(label(0)).toBe("PR #42 · a check failed (wayland-native)");
  await new Promise((resolve) => setTimeout(resolve, 40));
  h.change({ failed: [{ id: "1", name: "wayland-native" }, { id: "2", name: "smoke" }] });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
  expect(label(1)).toBe("PR #42 · a check failed (smoke)");
  h.change({ checks: "done" });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
  expect(label(2)).toBe("PR #42 · checks finished");
  h.change({ head: "head-2", checks: "pending", failed: [] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  h.change({ failed: [{ id: "3", name: "wayland-native" }] });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(4));
  expect(label(3)).toBe("PR #42 · a check failed (wayland-native)");
});
it("reads a baseline saved in the old combined format without a wake", async () => {
  const h = await harness();
  await h.call("watch-start", { threadId: "a", url: URL });
  await h.registry.deactivate("tau.review");
  const file = join(h.stateDir, "tau.review", "pr-watches.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.watches[0].baseline = { state: "OPEN", head: "head-1", checks: JSON.stringify(["FAILURE", [[1, "FAILURE", "2026-10-09T12:06:00Z"]]]), comments: "0", conflict: false };
  await writeFile(file, JSON.stringify(stored));
  const restored = await harness(h.stateDir, { ...initial, checks: "done", failed: [{ id: "1", name: "wayland-native" }] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(restored.send).not.toHaveBeenCalled();
  restored.change({ comments: "1" });
  await vi.waitFor(() => expect(restored.send).toHaveBeenCalledTimes(1));
  expect(wakeLabel(restored.send, 0)).toBe("PR #42 · new comments or reviews");
});
it("queues marked deduplicated wakes, persists before admission, survives restart, and Stop ends every watch", async () => {
  const h = await harness();
  await h.call("watch-start", { threadId: "a", url: URL });
  h.change({ checks: "done" });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(h.send).toHaveBeenCalledWith("a", expect.stringContaining("checks finished"), { delivery: "queue", wake: { source: "pull-request", label: "PR #42 · checks finished" } });
  await h.registry.deactivate("tau.review");
  const restored = await harness(h.stateDir, { ...initial, checks: "done" });
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
it("rereads the request once for its thread links when a push or merge is seen, not on other changes", async () => {
  const h = await harness();
  for (const threadId of ["a", "b"]) await h.call("watch-start", { threadId, url: URL });
  h.change({ comments: "1" });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
  expect(h.reread).not.toHaveBeenCalled();
  h.change({ head: "head-2" });
  await vi.waitFor(() => expect(h.reread).toHaveBeenCalledTimes(1));
  h.change({ state: "MERGED" });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(4));
  expect(h.reread.mock.calls).toEqual([[URL], [URL]]);
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
  expect(await readWatchSnapshot(tools, parseRequestUrl(URL)!)).toMatchObject({ state: "OPEN", checks: "done", conflict: true });
  expect(cli).toHaveBeenCalledTimes(1);
  expect(cli.mock.calls[0]).toBeDefined();
  cli.mockResolvedValueOnce(JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", headRefOid: "head", reviewThreads: { pageInfo: { hasPreviousPage: true } } } } } }));
  await expect(readWatchSnapshot(tools, parseRequestUrl(URL)!)).rejects.toThrow("more than 100");
});

it("counts checks as done only when no run, status or workflow is still going, and names failed ones", async () => {
  const pr = (commit: unknown) => JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", headRefOid: "head", reviewThreads: { pageInfo: { hasPreviousPage: false } }, commits: { nodes: [{ commit }] } } } } });
  const run = (databaseId: number, name: string, status: string, conclusion?: string) => ({ databaseId, name, status, conclusion });
  const ci = (status: string) => ({ checkSuites: { nodes: [{ status: "QUEUED", workflowRun: null }, { status, workflowRun: { databaseId: 9 } }] } });
  const cli = vi.fn(async () => "");
  const tools = { cli, cached: (_kind: string, _ref: unknown, _fresh: boolean, read: () => unknown) => read() } as never;
  const read = async (commit: unknown) => { cli.mockResolvedValueOnce(pr(commit)); const { checks, failed } = await readWatchSnapshot(tools, parseRequestUrl(URL)!); return { checks, failed }; };
  expect(await read({ ...ci("IN_PROGRESS"), statusCheckRollup: { state: "PENDING", contexts: { nodes: [run(1, "wayland-native", "COMPLETED", "SUCCESS"), run(2, "test (1/3)", "IN_PROGRESS")] } } })).toEqual({ checks: "pending", failed: [] });
  // Between `checks` finishing and `smoke` starting, only the unfinished workflow run shows that more is coming.
  expect(await read({ ...ci("IN_PROGRESS"), statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [run(1, "checks", "COMPLETED", "SUCCESS")] } } })).toEqual({ checks: "pending", failed: [] });
  expect(await read({ ...ci("IN_PROGRESS"), statusCheckRollup: { state: "PENDING", contexts: { nodes: [run(1, "wayland-native", "COMPLETED", "TIMED_OUT"), run(2, "test", "COMPLETED", "SKIPPED"), { context: "ci/legacy", state: "ERROR", targetUrl: "https://ci/1" }, run(3, "smoke", "QUEUED")] } } })).toEqual({ checks: "pending", failed: [{ id: "1", name: "wayland-native" }, { id: "ci/legacy https://ci/1", name: "ci/legacy" }] });
  expect(await read({ ...ci("COMPLETED"), statusCheckRollup: { state: "FAILURE", contexts: { nodes: [run(1, "smoke", "COMPLETED", "STARTUP_FAILURE")] } } })).toEqual({ checks: "done", failed: [{ id: "1", name: "smoke" }] });
  expect(await read({ checkSuites: { nodes: [{ status: "QUEUED", workflowRun: null }] }, statusCheckRollup: null })).toEqual({ checks: "none", failed: [] });
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
it("names the head commit and the failed jobs, so a wake about an older push reads as one", () => {
  const ref = { url: URL, number: 42 } as PullRequestWatch["ref"];
  const text = wakeText({ ref }, ["a check failed (test (2/3))"], { state: "OPEN", head: "abc123", checks: "done", failed: [{ id: "987", name: "test (2/3)" }, { id: "lint https://ci", name: "lint" }], comments: "0", conflict: false });
  expect(text).toContain(`Pull request #42 (${URL}) at head commit abc123: a check failed (test (2/3)).`);
  expect(text).toContain("- test (2/3): job 987 (gh run view --job 987 --log-failed)");
  expect(text).not.toContain("lint:");
  expect(text).toContain("If you pushed since, these results belong to the older commit.");
});
