import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_LINK_ENTRY, type HostExtensionRegistry, type HostMcpTool, type HostTurnObserver, type RuntimeSessionInfo, type HostThread } from "tau/host-extension";
import type { UiFileDiff } from "tau";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { isGuideSession, registerGuides } from "./guide-host.js";
import { GUIDE_AGENT, GUIDE_DIFF_TOOL, GUIDE_EVENT, GUIDE_SUBMIT_TOOL, type GuideEvent, type GuideResult, type GuideWriteResult } from "./guide-protocol.js";
import type { SourceControl } from "./provider-registry.js";
import { PROVIDERS, type RequestService, type PullRequestDetail, type PullRequestFiles } from "./protocol.js";
import type { PullRequestReads } from "./pull-request-host.js";
import { parseRequestUrl } from "./pull-request-json.js";

const URL = "https://github.com/example/project/pull/42";
const OTHER = "https://github.com/example/project/pull/43";
const FOREIGN = "https://github.com/someone/else/pull/7";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const diff = (path: string, added: number[]): UiFileDiff => ({ path, added: added.length, removed: 0, hunks: [{ header: "@@", lines: added.map((newLine) => ({ kind: "added" as const, newLine, text: `line ${newLine}` })) }] });
const files: PullRequestFiles = {
  files: [{ path: "a.ts", status: "modified", added: 3, removed: 0, viewed: "unviewed" }, { path: "b.ts", status: "modified", added: 1, removed: 0, viewed: "unviewed" }],
  diffs: [diff("a.ts", [10, 11, 12]), diff("b.ts", [1])],
  viewedOn: "host",
};
const detail = (number: number, headSha: string): PullRequestDetail => ({
  ref: parseRequestUrl(`https://github.com/example/project/pull/${number}`)!, title: `Title ${number}`, body: "Description", state: "open", draft: false, baseRef: "main", headSha,
  additions: 4, deletions: 0, changedFiles: 2, reviewers: [], labels: [], commits: [{ oid: "abcdef1234", headline: "First commit", committedAt: "" }],
} as unknown as PullRequestDetail);

interface Options { enabled?: boolean; model?: string; effort?: string; levels?: string[]; instructions?: string; stateDir?: string; spawnStatus?: string; service?: RequestService; headRef?: boolean; catalogWait?: Promise<void>; writer?: string }

async function harness(options: Options = {}) {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), "tau-guides-"));
  if (!options.stateDir) cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const heads = new Map<number, string>([[42, "head-1"], [43, "head-1"]]);
  const events: GuideEvent[] = [];
  let duringSpawn: (() => Promise<void>) | undefined;
  const spawn = vi.fn(async (input: unknown) => {
    const beforePrompt = (input as { beforePrompt: (thread: HostThread) => Promise<void> }).beforePrompt;
    if (options.writer === "codex" && options.spawnStatus !== "pending") await beforePrompt({ sessionId: "guide-thread", backendKind: "codex", parentThreadId: "parent" } as HostThread);
    await duringSpawn?.();
    return { threadId: "guide-thread", status: options.spawnStatus ?? "running" };
  });
  const stop = vi.fn(async (_input: unknown) => ({}));
  const discard = vi.fn(async (_input: unknown) => ({ detail: "" }));
  const notify = vi.fn(async (_input: unknown) => undefined);
  const fetchHead = vi.fn(async () => undefined);
  const catalogRead = vi.fn();
  let observer: HostTurnObserver | undefined;
  let mcp: ((session: RuntimeSessionInfo) => HostMcpTool[] | Promise<readonly HostMcpTool[]>) | undefined;
  let runtime: ((pi: unknown, session: RuntimeSessionInfo) => void) | undefined;
  const service = options.service ?? "github";
  const host = service === "gitlab" ? "gitlab.com" : service === "forgejo" ? "codeberg.org" : service === "bitbucket" ? "bitbucket.org" : "github.com";
  const requestUrl = (number: number) => `https://${host}/example/project/${service === "gitlab" ? "-/merge_requests" : service === "forgejo" ? "pulls" : "pull"}/${number}`;
  const provider = {
    info: { ...PROVIDERS[service], capabilities: { ...PROVIDERS[service].capabilities, conversations: false } }, repository: () => ({ host, repo: "example/project" }),
    ...(options.headRef === false ? {} : { requestHeadRef: (ref: { number: number }) => `refs/${service === "gitlab" ? "merge-requests" : "pull"}/${ref.number}/head` }),
    requestUrl: (target: { host: string; repo: string }, number: number) => `https://${target.host}/${target.repo}/pull/${number}`, threads: async () => [],
  };
  const sources = { forUrl: (url: string) => { const ref = parseRequestUrl(url); return ref ? { ref, provider } : undefined; }, detect: async () => service, get: () => provider } as unknown as SourceControl;
  const reads: PullRequestReads = {
    detail: async (ref) => ({ ...detail(ref.number, heads.get(ref.number) ?? "head-1"), ref }),
    files: async () => structuredClone(files),
  };
  const workspace = async () => ({ root: "/repo", base: "main", remote: { name: "origin", url: `git@${host}:example/project.git` } });
  let ids = 0;
  const registry: HostExtensionRegistry = await activateHostKit({
    id: "tau.review", name: "Review", permissions: ["sessions", "runtime:extend"],
    activate: (context) => {
      const guides = registerGuides(context, sources, reads, workspace, { fetchHead, wait: async () => undefined, runId: () => `run-${++ids}`, now: () => Date.parse("2026-10-12T10:00:00Z") });
      return () => guides.dispose();
    },
  }, {
    stateDir,
    settings: async () => ({ options: { "review-guides": options.enabled ?? true }, values: { "review-guide-runtime": options.writer ?? "", "review-guide-model": options.model ?? "", "review-guide-effort": options.effort ?? "", "review-guide-instructions": options.instructions ?? "" } }),
    thread: ((id: string) => id === "parent" ? { sessionId: "parent", cwd: "/repo" } : id === "guide-thread" ? { sessionId: id, cwd: "/wt", model: { provider: "anthropic", id: "haiku" } } : undefined) as never,
    runtimeChoices: async () => { catalogRead(); await options.catalogWait; return [{ backend: { kind: "pi", label: "Pi" }, enabled: true, readiness: { kind: "pi", label: "Pi", state: "ready" }, catalog: { kind: "pi", models: [{ provider: "test", id: "guide", name: "Guide" }], thinkingLevels: { "test/guide": options.levels ?? ["off", "low", "high"] } } }]; },
    registerTurnObserver: (value) => { observer = value; return () => undefined; },
    mcp: { registerTools: (offer) => { mcp = offer as typeof mcp; return () => undefined; }, gate: () => () => undefined, registerInstructions: () => () => undefined, connect: async () => undefined },
    registerRuntimeExtension: (_name, setup) => { runtime = setup as typeof runtime; return () => undefined; },
  }, (event: PublishedKitEvent) => { if (event.name === GUIDE_EVENT) events.push(event.payload as GuideEvent); });
  await registry.activate({ id: "tau.agents", name: "Agents", permissions: [], activate: (context) => {
    context.registerCommand("spawn", (input) => spawn(input), { callers: ["tau.review"] });
    context.registerCommand("stop-agent", (input) => stop(input), { callers: ["tau.review"] });
    context.registerCommand("discard-changes", (input) => discard(input), { callers: ["tau.review"] });
  } });
  await registry.activate({ id: "tau.push", name: "Push", permissions: [], activate: (context) => { context.registerCommand("notify", (input) => notify(input), { callers: ["tau.review"] }); } });
  cleanups.push(() => registry.deactivate("tau.review"));
  const call = <T>(command: string, input?: unknown) => registry.invoke("tau.review", command, input) as Promise<T>;
  const write = (url = requestUrl(42), extra: Record<string, unknown> = {}) => call<GuideWriteResult>("guide-write", { url, threadId: "parent", ...extra });
  const tool = async (session: RuntimeSessionInfo, name: string) => (await mcp!(session)).find((entry) => entry.name === name)!;
  const guideTools = (sessionId = "guide-thread") => {
    const registered: HostMcpTool[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const activeTools = vi.fn();
    runtime!({ registerTool: (entry: HostMcpTool) => registered.push(entry), on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler), getActiveTools: () => ["read", GUIDE_DIFF_TOOL, GUIDE_SUBMIT_TOOL, "write_pull_request_guides"], setActiveTools: activeTools },
      { sessionId, cwd: "/wt", parentThreadId: "parent" });
    return { registered, handlers, activeTools, find: (name: string) => registered.find((entry) => entry.name === name)! };
  };
  const run = (entry: HostMcpTool, params: unknown) => entry.execute("id", params as never, undefined as never, undefined as never, undefined as never);
  return { beforeSpawnReturn: (callback: () => Promise<void>) => { duringSpawn = callback; }, stateDir, catalogRead, call, write, spawn, stop, discard, notify, fetchHead, events, heads, tool, guideTools, run, ended: (outcome: "completed" | "failed" = "completed") => observer!.runEnded!("guide-thread", outcome) };
}

const submission = { runId: "run-1", stops: [{ title: "The contract", summary: "Shape first.", excerpts: [{ path: "a.ts", side: "new", start: 1, end: 11, caption: "shape" }], notes: [{ path: "a.ts", line: 10, title: "why", body: "because" }], questions: ["Why?"] }] };

describe("write", () => {
  it("refuses while the beta is off, and says where to turn it on", async () => {
    const h = await harness({ enabled: false });
    const result = await h.write();
    expect(result).toMatchObject({ outcome: "failed", enabled: false });
    expect(result.detail).toContain("Settings");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("refuses an unsupported provider, a thread that is not open and another repository", async () => {
    const unsupported = await harness({ service: "bitbucket" });
    expect((await unsupported.write()).detail).toContain("does not support");
    expect(unsupported.fetchHead).not.toHaveBeenCalled();
    expect(unsupported.spawn).not.toHaveBeenCalled();
    const h = await harness();
    expect((await h.write(URL, { threadId: "gone" })).detail).toContain("Open a thread");
    expect((await h.write(FOREIGN)).detail).toContain("someone/else");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("fetches the head, starts the guide agent read-only in a worktree of that commit and returns at once", async () => {
    const h = await harness({ model: "anthropic/claude-haiku-4-5-20251001", instructions: "Short stops." });
    const result = await h.write();
    expect(result).toMatchObject({ outcome: "started", threadId: "guide-thread", run: { state: "running", headSha: "head-1" }, currentHeadSha: "head-1", enabled: true });
    expect(h.fetchHead).toHaveBeenCalledWith("/repo", "origin", "head-1", "refs/pull/42/head");
    const input = h.spawn.mock.calls[0]![0] as { parentThreadId: string; startAt: string; model: string; source: string; prompt: string; definition: { name: string; access: string; tools: string[]; runtime: string } };
    expect(input).toMatchObject({ parentThreadId: "parent", startAt: "head-1", model: "anthropic/claude-haiku-4-5-20251001", source: "tau.review", definition: { name: GUIDE_AGENT, access: "read-only", runtime: "pi" } });
    expect(input.definition.tools).toEqual(["read", "grep", "find", "ls", GUIDE_DIFF_TOOL, GUIDE_SUBMIT_TOOL]);
    expect(input.prompt).toContain("run id is run-1");
    expect(input.prompt).toContain("<pr_title>Title 42</pr_title>");
    expect(input.prompt).toContain("Short stops.");
    expect(h.events).toEqual([expect.objectContaining({ kind: "running", number: 42, parentThreadId: "parent" })]);
  });

  it.each(["gitlab", "forgejo"] as const)("writes and normalizes a %s guide while keeping the writer read-only", async (service) => {
    const h = await harness({ service });
    expect((await h.write()).outcome).toBe("started");
    expect(h.fetchHead).toHaveBeenCalledWith("/repo", "origin", "head-1", `refs/${service === "gitlab" ? "merge-requests" : "pull"}/42/head`);
    expect(h.spawn).toHaveBeenCalledWith(expect.objectContaining({ startAt: "head-1", definition: expect.objectContaining({ access: "read-only", runtime: "pi" }) }));
    await h.run(h.guideTools().find(GUIDE_SUBMIT_TOOL), submission);
    const url = service === "gitlab" ? "https://gitlab.com/example/project/-/merge_requests/42" : "https://codeberg.org/example/project/pulls/42";
    expect(await h.call<GuideResult>("guide-get", { url })).toMatchObject({ guide: { headSha: "head-1", stops: [expect.objectContaining({ excerpts: [{ path: "a.ts", side: "new", start: 10, end: 11, caption: "shape" }] }), expect.objectContaining({ title: "Other files" })] } });
    h.ended();
    await vi.waitFor(() => expect(h.discard).toHaveBeenCalled());
  });

  it("refuses a provider without a head ref and refuses a head changed during fetching", async () => {
    const missing = await harness({ headRef: false });
    expect((await missing.write()).outcome).toBe("failed");
    expect(missing.fetchHead).not.toHaveBeenCalled();
    const h = await harness({ service: "gitlab" });
    h.fetchHead.mockImplementationOnce(async () => { h.heads.set(42, "head-2"); });
    expect(await h.write()).toMatchObject({ outcome: "failed", detail: expect.stringContaining("head changed") });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("rejects a submission after a push without storing it", async () => {
    const h = await harness({ service: "forgejo" });
    await h.write();
    h.heads.set(42, "head-2");
    await expect(h.run(h.guideTools().find(GUIDE_SUBMIT_TOOL), submission)).rejects.toThrow("head changed");
    expect((await h.call<GuideResult>("guide-get", { url: "https://codeberg.org/example/project/pulls/42" })).guide).toBeNull();
  });

  it("rechecks the head after waiting for the effort catalog, before spawning", async () => {
    let release!: () => void;
    const catalogWait = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness({ service: "gitlab", model: "test/guide", effort: "high", catalogWait });
    const writing = h.write();
    await vi.waitFor(() => expect(h.catalogRead).toHaveBeenCalled());
    h.heads.set(42, "head-2");
    release();
    expect(await writing).toMatchObject({ outcome: "failed", detail: expect.stringContaining("head changed") });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("passes the configured effort to the guide run", async () => {
    const h = await harness({ model: "test/guide", effort: "high" });
    expect((await h.write()).outcome).toBe("started");
    expect(h.spawn).toHaveBeenCalledWith(expect.objectContaining({ model: "test/guide", thinkingLevel: "high" }));
  });

  it.each([
    { model: "test/guide" },
    { model: "test/guide", effort: "invalid" },
    { model: "test/guide", effort: "high", levels: ["off"] },
    { model: "test/missing", effort: "high" },
    { effort: "high" },
  ])("keeps default effort for unsupported or absent selections %j", async (options) => {
    const h = await harness(options);
    expect((await h.write()).outcome).toBe("started");
    expect(h.spawn.mock.calls[0]![0]).not.toHaveProperty("thinkingLevel");
  });

  it.each(["github", "gitlab", "forgejo"] as const)("joins and replaces guide runs on %s", async (service) => {
    const h = await harness({ service });
    await h.write();
    expect(await h.write()).toMatchObject({ outcome: "running" });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.heads.set(42, "head-2");
    expect(await h.write()).toMatchObject({ outcome: "started", run: { headSha: "head-2" } });
    expect(h.stop).toHaveBeenCalledWith({ threadId: "guide-thread" });
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.fetchHead).toHaveBeenLastCalledWith("/repo", "origin", "head-2", `refs/${service === "gitlab" ? "merge-requests" : "pull"}/42/head`);
  });

  it("reports a failed fetch as a failed run the reader can retry", async () => {
    const h = await harness();
    h.fetchHead.mockRejectedValueOnce(new Error("network down"));
    const result = await h.write();
    expect(result).toMatchObject({ outcome: "failed", detail: "network down", run: { state: "failed", detail: "network down" } });
    expect(h.events.at(-1)).toMatchObject({ kind: "failed" });
    expect(await h.write()).toMatchObject({ outcome: "started" });
  });
});

describe("the guide agent's tools", () => {
  it("lists the files, then one file's diff with the numbers to use", async () => {
    const h = await harness();
    await h.write();
    const { find } = h.guideTools();
    const list = await h.run(find(GUIDE_DIFF_TOOL), { runId: "run-1" });
    expect(JSON.stringify(list)).toContain("a.ts");
    expect(JSON.stringify(list)).toContain("First commit");
    const one = JSON.stringify(await h.run(find(GUIDE_DIFF_TOOL), { runId: "run-1", path: "a.ts" }));
    expect(one).toContain("new    10 | line 10");
  });

  it("stores a normalized guide, clears the run, tells the window and the phone, and answers the agent", async () => {
    const h = await harness();
    await h.write();
    const { find } = h.guideTools();
    const answer = await h.run(find(GUIDE_SUBMIT_TOOL), submission);
    expect(JSON.stringify(answer)).toContain("Stored a guide with 2 stops");
    const result = await h.call<GuideResult>("guide-get", { url: URL });
    expect(result.run).toBeNull();
    expect(result.guide).toMatchObject({ headSha: "head-1", generatedAt: "2026-10-12T10:00:00.000Z", model: "anthropic/haiku" });
    // The excerpt was clamped to the changed lines 10 to 11, and b.ts, which the agent forgot, is in the skim stop.
    expect(result.guide!.stops[0]!.excerpts).toEqual([{ path: "a.ts", side: "new", start: 10, end: 11, caption: "shape" }]);
    expect(result.guide!.stops[0]!.notes).toHaveLength(1);
    expect(result.guide!.stops.at(-1)).toMatchObject({ title: "Other files", files: [{ path: "b.ts" }] });
    expect(h.events.at(-1)).toMatchObject({ kind: "ready", number: 42, title: "Title 42" });
    expect(h.notify).toHaveBeenCalledWith({ threadId: "parent", kind: "completed", text: "Review guide ready for #42" });
  });

  it("refuses a call for a run that is over, one from another thread and an empty tour", async () => {
    const h = await harness();
    await h.write();
    const { find } = h.guideTools();
    await expect(h.run(find(GUIDE_SUBMIT_TOOL), { ...submission, runId: "run-9" })).rejects.toThrow("over");
    await expect(h.run(find(GUIDE_SUBMIT_TOOL), { runId: "run-1", stops: [] })).rejects.toThrow("at least one stop");
    // The run is bound to the thread that started it; another thread cannot submit for it.
    await expect(h.run(h.guideTools("someone-else").find(GUIDE_SUBMIT_TOOL), submission)).rejects.toThrow("another thread");
    // A stop whose excerpts all miss the change still lands, with its files in the skim stop.
    await expect(h.run(find(GUIDE_SUBMIT_TOOL), { runId: "run-1", stops: [{ title: "Ghost", summary: "", excerpts: [{ path: "nope.ts", side: "new", start: 1, end: 2 }] }] })).resolves.toBeDefined();
  });

  it("does not store a guide for a run a newer head replaced", async () => {
    const h = await harness();
    await h.write();
    h.heads.set(42, "head-2");
    await h.write();
    const { find } = h.guideTools();
    await expect(h.run(find(GUIDE_SUBMIT_TOOL), submission)).rejects.toThrow("over");
    expect((await h.call<GuideResult>("guide-get", { url: URL })).guide).toBeNull();
  });

  it("fails the run when the agent ends without a guide, and removes its worktree", async () => {
    const h = await harness();
    await h.write();
    await h.ended("completed");
    expect(await h.call<GuideResult>("guide-get", { url: URL })).toMatchObject({ run: { state: "failed", headSha: "head-1", detail: expect.stringContaining("without submitting") } });
    await vi.waitFor(() => expect(h.discard).toHaveBeenCalledWith({ threadId: "guide-thread" }));
    expect(h.events.at(-1)).toMatchObject({ kind: "failed" });
  });

  it("tries again to remove the worktree when the agent still counts as busy", async () => {
    const h = await harness();
    await h.write();
    h.discard.mockRejectedValueOnce(new Error("This thread is still working")).mockRejectedValueOnce(new Error("still working"));
    await h.ended("completed");
    await vi.waitFor(() => expect(h.discard).toHaveBeenCalledTimes(3));
  });

  it("says a failed agent failed, and keeps a stored guide when the run after it fails", async () => {
    const h = await harness();
    await h.write();
    await h.run(h.guideTools().find(GUIDE_SUBMIT_TOOL), submission);
    await h.ended("completed");
    await vi.waitFor(() => expect(h.discard).toHaveBeenCalledTimes(1));
    h.heads.set(42, "head-2");
    await h.write();
    await h.ended("failed");
    const result = await h.call<GuideResult>("guide-get", { url: URL });
    expect(result.guide?.headSha).toBe("head-1");
    expect(result.run).toMatchObject({ state: "failed", detail: expect.stringContaining("failed") });
  });

  it("registers its two tools on sub-agents only, and lists them for the guide agent alone", async () => {
    const h = await harness();
    const guide = h.guideTools();
    expect(guide.registered.map((entry) => entry.name)).toEqual(expect.arrayContaining([GUIDE_DIFF_TOOL, GUIDE_SUBMIT_TOOL, "write_pull_request_guides", "read_pull_request_guide"]));
    const entries = [{ type: "custom", customType: PARENT_LINK_ENTRY, data: { persona: { name: GUIDE_AGENT } } }];
    guide.handlers.get("session_start")!({}, { sessionManager: { getEntries: () => entries } });
    expect(guide.activeTools).not.toHaveBeenCalled();
    guide.handlers.get("session_start")!({}, { sessionManager: { getEntries: () => [{ type: "custom", customType: PARENT_LINK_ENTRY, data: { persona: { name: "reviewer" } } }] } });
    expect(guide.activeTools).toHaveBeenCalledWith(["read", "write_pull_request_guides"]);
    expect(isGuideSession(entries)).toBe(true);
    expect(isGuideSession([])).toBe(false);
  });
});

describe("tools for any agent", () => {
  const session = { sessionId: "parent", cwd: "/repo" };

  it("starts several runs without waiting and answers each on its own", async () => {
    const h = await harness();
    const write = await h.tool(session, "write_pull_request_guides");
    const answer = JSON.parse((await h.run(write, { pullRequests: [{ url: URL }, { repository: "example/project", number: 43 }, { url: FOREIGN }, { number: 0 }] }) as { content: { text: string }[] }).content[0]!.text);
    expect(answer.pullRequests.map((entry: { outcome: string }) => entry.outcome)).toEqual(["started", "started", "failed", "failed"]);
    expect(answer.pullRequests[2].detail).toContain("someone/else");
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it("refuses an empty list and more than twenty", async () => {
    const h = await harness();
    const write = await h.tool(session, "write_pull_request_guides");
    await expect(h.run(write, { pullRequests: [] })).rejects.toThrow("1 to 20");
    await expect(h.run(write, { pullRequests: Array.from({ length: 21 }, () => ({ url: URL })) })).rejects.toThrow("1 to 20");
  });

  it("reads the guide with its run, the current head and whether it is stale", async () => {
    const h = await harness();
    const read = await h.tool(session, "read_pull_request_guide");
    const empty = JSON.parse((await h.run(read, { url: URL }) as { content: { text: string }[] }).content[0]!.text);
    expect(empty).toMatchObject({ guide: null, run: null, currentHeadSha: "head-1", stale: false });
    await h.write();
    await h.run(h.guideTools().find(GUIDE_SUBMIT_TOOL), submission);
    const fresh = JSON.parse((await h.run(read, { url: URL }) as { content: { text: string }[] }).content[0]!.text);
    expect(fresh).toMatchObject({ stale: false, guide: { headSha: "head-1" } });
    h.heads.set(42, "head-2");
    expect(JSON.parse((await h.run(read, { url: URL }) as { content: { text: string }[] }).content[0]!.text)).toMatchObject({ stale: true, currentHeadSha: "head-2" });
  });

  it("is off for agents as well as people", async () => {
    const h = await harness({ enabled: false });
    const read = await h.tool(session, "read_pull_request_guide");
    await expect(h.run(read, { url: URL })).rejects.toThrow("off");
    const write = await h.tool(session, "write_pull_request_guides");
    const answer = JSON.parse((await h.run(write, { pullRequests: [{ url: URL }] }) as { content: { text: string }[] }).content[0]!.text);
    expect(answer.pullRequests[0]).toMatchObject({ outcome: "failed" });
  });
});

describe("storage", () => {
  it("keeps a guide across a restart and across a push, which only makes it stale", async () => {
    const first = await harness();
    await first.write();
    await first.run(first.guideTools().find(GUIDE_SUBMIT_TOOL), submission);
    await first.call("guide-get", { url: URL });
    const second = await harness({ stateDir: first.stateDir });
    second.heads.set(42, "head-3");
    const result = await second.call<GuideResult>("guide-get", { url: URL });
    expect(result.guide?.headSha).toBe("head-1");
    expect(result.currentHeadSha).toBe("head-3");
    // One guide per request: another request has none.
    expect((await second.call<GuideResult>("guide-get", { url: OTHER })).guide).toBeNull();
  });
});

describe("Codex guide writer", () => {
  const session = { sessionId: "guide-thread", cwd: "/wt" };
  it("keeps the Pi default and refuses an unsupported writer before fetch or spawn", async () => {
    const h = await harness({ writer: "claude-code" });
    expect(await h.write()).toMatchObject({ outcome: "failed", detail: expect.stringContaining("Choose Pi or Codex") });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.fetchHead).not.toHaveBeenCalled();
  });
  it("uses Codex's runtime model with reading tools and run-specific MCP submission", async () => {
    const h = await harness({ writer: "codex", model: "test/pi-model", effort: "high" });
    await h.write();
    const request = h.spawn.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.definition).toMatchObject({ runtime: "codex", tools: ["read", "grep", "find", "ls", GUIDE_DIFF_TOOL, GUIDE_SUBMIT_TOOL] });
    expect(request.definition).not.toHaveProperty("access");
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("thinkingLevel");
    expect(await h.tool({ sessionId: "parent", cwd: "/repo" }, GUIDE_SUBMIT_TOOL)).toBeUndefined();
    expect(await h.tool({ sessionId: "unrelated", cwd: "/wt" }, GUIDE_SUBMIT_TOOL)).toBeUndefined();
    const diffTool = await h.tool(session, GUIDE_DIFF_TOOL);
    expect(JSON.stringify(await h.run(diffTool, { runId: "run-1" }))).toContain("a.ts");
    const submit = await h.tool(session, GUIDE_SUBMIT_TOOL);
    await expect(h.run(submit, { ...submission, runId: "another-run" })).rejects.toThrow("over or was replaced");
    await expect(h.run(h.guideTools("unrelated").find(GUIDE_SUBMIT_TOOL), submission)).rejects.toThrow("another thread");
    await h.run(submit, submission);
    expect((await h.call<GuideResult>("guide-get", { url: URL })).guide?.stops[0]?.excerpts).toEqual([{ path: "a.ts", side: "new", start: 10, end: 11, caption: "shape" }]);
    expect(await h.tool(session, GUIDE_SUBMIT_TOOL)).toBeUndefined();
  });
  it("admits a queued child before its MCP tools are offered, and refuses a replaced admission", async () => {
    const h = await harness({ writer: "codex", spawnStatus: "pending" });
    await h.write();
    expect(await h.tool(session, GUIDE_SUBMIT_TOOL)).toBeUndefined();
    const old = (h.spawn.mock.calls[0]![0] as { beforePrompt: (thread: HostThread) => Promise<void> }).beforePrompt;
    h.heads.set(42, "head-2");
    await h.write();
    await expect(old({ sessionId: "old", backendKind: "codex", parentThreadId: "parent" } as HostThread)).rejects.toThrow("replaced or cancelled");
    const admit = (h.spawn.mock.calls[1]![0] as { beforePrompt: (thread: HostThread) => Promise<void> }).beforePrompt;
    await admit({ sessionId: session.sessionId, backendKind: "codex", parentThreadId: "parent" } as HostThread);
    expect(await h.tool(session, GUIDE_SUBMIT_TOOL)).toBeTruthy();
    await h.run((await h.tool(session, GUIDE_SUBMIT_TOOL)), { ...submission, runId: "run-2" });
    expect((await h.call<GuideResult>("guide-get", { url: URL })).guide?.headSha).toBe("head-2");
  });
  it("fails a queued admission after a push without offering tools or disturbing a newer run", async () => {
    const h = await harness({ writer: "codex", spawnStatus: "pending" });
    await h.write();
    const admit = (h.spawn.mock.calls[0]![0] as { beforePrompt: (thread: HostThread) => Promise<void> }).beforePrompt;
    h.heads.set(42, "head-2");
    await expect(admit({ sessionId: session.sessionId, backendKind: "codex", parentThreadId: "parent" } as HostThread)).rejects.toThrow("head changed");
    expect(await h.tool(session, GUIDE_SUBMIT_TOOL)).toBeUndefined();
    expect(await h.call<GuideResult>("guide-get", { url: URL })).toMatchObject({ run: { state: "failed" } });
  });

  it("cleans up early completion without re-registering the ended thread after spawn returns", async () => {
    const h = await harness({ writer: "codex" });
    h.beforeSpawnReturn(async () => {
      await h.run(await h.tool(session, GUIDE_SUBMIT_TOOL), submission);
      h.ended();
    });
    expect(await h.write()).toMatchObject({ outcome: "started", guide: { headSha: "head-1" }, run: null });
    await vi.waitFor(() => expect(h.discard).toHaveBeenCalledTimes(1));
    h.ended();
    expect(h.discard).toHaveBeenCalledTimes(1);
  });
  it("revokes tools after failure and rejects submission after a push", async () => {
    const h = await harness({ writer: "codex" });
    await h.write();
    const submit = await h.tool(session, GUIDE_SUBMIT_TOOL);
    h.heads.set(42, "head-2");
    await expect(h.run(submit, submission)).rejects.toThrow("head changed");
    h.ended("failed");
    expect(await h.tool(session, GUIDE_SUBMIT_TOOL)).toBeUndefined();
    expect((await h.call<GuideResult>("guide-get", { url: URL })).guide).toBeNull();
    await vi.waitFor(() => expect(h.discard).toHaveBeenCalled());
  });
});
