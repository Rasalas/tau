import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionContext, HostMcpToolProvider, HostThreadLifecycle, RuntimeExtensionFactory } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, THREAD_LINKS_EVENT, type PullRequestDetail, type PullRequestFiles, type PullRequestList, type PullRequestLists, type PullRequestThread, type ThreadPullRequestLink } from "./protocol.js";
import { parseRemote } from "./pull-request-hosting.js";
import type { CliRunOptions } from "./request-cli.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");

const GITHUB_URL = "https://github.com/acme/tau/pull/7";
const GITLAB_URL = "https://gitlab.com/acme/tools/tau/-/merge_requests/12";

interface Call {
  args: string[];
  input?: string;
  cwd: string;
}

let stateRoot: string | undefined;
afterEach(async () => { if (stateRoot) await rm(stateRoot, { recursive: true, force: true }); stateRoot = undefined; });

/**
 * Review Kit over a fake `gh`/`glab`, a Workspace Kit that answers the
 * project's remote, and the host seams the links register with, recorded.
 */
async function harness(options: { remote?: string; remotes?: Record<string, string | null>; viewer?: string; answer?(call: Call): string | Promise<string> | undefined } = {}) {
  stateRoot = await mkdtemp(join(tmpdir(), "tau-pr-overview-"));
  const calls: Call[] = [];
  const events: PublishedKitEvent[] = [];
  const providers: HostMcpToolProvider[] = [];
  const runtime: RuntimeExtensionFactory[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const instructions: Array<(thread: { sessionId: string; cwd: string }) => string | undefined> = [];
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      context.registerCommand("review-request-context", (input) => {
        const root = (input as { workspace?: string } | undefined)?.workspace ?? "/project";
        const url = options.remotes && root in options.remotes ? options.remotes[root] : options.remote ?? "git@github.com:acme/tau.git";
        return { root, base: "main", ...(url ? { remote: { name: "origin", url } } : {}) };
      }, { callers: [REVIEW_HOST_EXTENSION_ID] });
    },
  };
  const run = vi.fn(async (_command: string, args: string[], cwd: string, runOptions?: CliRunOptions) => {
    if (args[0] === "api" && args.at(-1) === "user") return JSON.stringify(options.viewer === undefined ? {} : { login: options.viewer, username: options.viewer });
    const call: Call = { args, cwd, ...(runOptions?.input !== undefined ? { input: runOptions.input } : {}) };
    calls.push(call);
    const answer = await options.answer?.(call);
    if (answer !== undefined) return answer;
    return defaultAnswer(call);
  });
  const registry = await activateHostKit(workspace, {
    findCommand: (name: string) => ({ gh: "/bin/gh", glab: "/bin/glab" } as Record<string, string>)[name],
    noteSubprocess: () => undefined,
    stateDir: stateRoot,
    thread: () => undefined,
    registerRuntimeExtension: (_name: string, factory: RuntimeExtensionFactory) => { runtime.push(factory); return () => undefined; },
    registerThreadLifecycle: (lifecycle: HostThreadLifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    mcp: {
      registerTools: (provider: HostMcpToolProvider) => { providers.push(provider); return () => undefined; },
      registerInstructions: (provider: (thread: { sessionId: string; cwd: string }) => string | undefined) => { instructions.push(provider); return () => undefined; },
      gate: () => () => undefined,
      connect: async () => undefined,
    },
  }, (event) => events.push(event));
  await registry.activate(createReviewHostExtension({ run }));
  const invoke = <T = unknown>(command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input) as Promise<T>;
  const tool = (name: string, thread = { sessionId: "thread-1", cwd: "/project" }) => {
    const found = providers.flatMap((provider) => provider(thread)).find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return (params: unknown) => found.execute("call-1", params, undefined, undefined, undefined as never) as Promise<{ details: unknown }>;
  };
  return { invoke, calls, events, providers, runtime, lifecycles, tool, instructions };
}

async function defaultAnswer({ args }: Call): Promise<string> {
  const joined = args.join(" ");
  if (joined.startsWith("pr list")) return fixture("gh-pr-list.json");
  if (joined.startsWith("pr view")) return fixture("gh-pr-view-discussed.json");
  if (joined.startsWith("pr diff")) return fixture("gh-pr-diff.patch");
  if (args[0] === "api" && args.includes("graphql") && args.some((arg) => arg.startsWith("query="))) return fixture("gh-pr-threads-discussed.json");
  if (args[0] === "api" && args.some((arg) => arg.includes("/merge_requests?"))) return fixture("glab-mr-list.json");
  if (args[0] === "api" && args.at(-1)?.includes("/discussions?")) return fixture("glab-discussions.json");
  if (args[0] === "api" && args.at(-1)?.includes("/commits?")) return fixture("glab-commits.json");
  if (args[0] === "api" && args.at(-1)?.includes("/diffs?")) return fixture("glab-diffs.json");
  if (args[0] === "api" && args.at(-1)?.endsWith("/merge_requests/12")) return fixture("glab-mr.json");
  return "{}";
}

describe("remotes", () => {
  it("reads the host and repository of the remote spellings Git takes", () => {
    expect(parseRemote("git@github.com:acme/tau.git")).toEqual({ host: "github.com", repo: "acme/tau" });
    expect(parseRemote("https://github.com/acme/tau")).toEqual({ host: "github.com", repo: "acme/tau" });
    expect(parseRemote("ssh://git@gitlab.example.com:2222/group/sub/tau.git")).toEqual({ host: "gitlab.example.com", repo: "group/sub/tau" });
    // An alias from ~/.ssh/config names no server a CLI knows.
    expect(parseRemote("work:acme/tau.git")).toBeUndefined();
    expect(parseRemote("")).toBeUndefined();
  });
});

describe("the Pull Requests page", () => {
  it("lists a GitHub repository's requests with who is asked to review, and says when there are more", async () => {
    const { invoke, calls } = await harness({ viewer: "niik" });
    const list = await invoke<PullRequestList>("pr-list", { workspace: "/checkout", state: "open", limit: 4 });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["pr", "list", "--repo", "github.com/acme/tau", "--state", "open", "--limit", "5"]));
    expect(calls[0]!.cwd).toBe("/checkout");
    expect(list).toMatchObject({ service: "github", host: "github.com", repo: "acme/tau", viewer: "niik", truncated: true, limit: 4 });
    expect(list.entries.map((entry) => [entry.ref.number, entry.state, entry.draft, entry.reviewDecision, entry.checks, entry.reviewRequested])).toEqual([
      [14485, "open", false, "review-required", "passing", true],
      [14475, "open", false, "review-required", "passing", false],
      [14474, "open", false, "review-required", "passing", true],
      [14355, "open", true, "review-required", "passing", false],
    ]);
    expect(list.entries[0]!.author).toEqual({ login: "dependabot", bot: true });
    expect(list.entries[2]!.labels.map((label) => label.name)).toEqual(["blocked", "external", "ready-for-review"]);
  });

  it("searches on the host and pages GitLab until it has enough", async () => {
    const { invoke, calls } = await harness({ remote: "https://gitlab.com/gitlab-org/cli.git", viewer: "GitLabDuo" });
    const list = await invoke<PullRequestList>("pr-list", { state: "all", limit: 3, search: "wizard" });
    const path = calls[0]!.args.at(-1)!;
    expect(path.startsWith("projects/gitlab-org%2Fcli/merge_requests?")).toBe(true);
    expect(new URLSearchParams(path.split("?")[1]).get("search")).toBe("wizard");
    expect(new URLSearchParams(path.split("?")[1]).get("state")).toBe("all");
    expect(list.entries).toHaveLength(3);
    expect(list.truncated).toBe(true);
    expect(list.entries[0]).toMatchObject({ state: "open", reviewDecision: "review-required", reviewRequested: true });
    expect(list.entries[0]!.mergeable).toBeUndefined();
  });

  it("lists every project's repository once across projects and hosts, and names the ones it could not read", async () => {
    const { invoke, calls } = await harness({
      viewer: "niik",
      remotes: { "/tau": "git@github.com:acme/tau.git", "/tau-worktree": "https://github.com/acme/tau.git", "/tools": "https://gitlab.com/acme/tools/tau.git", "/scratch": null },
    });
    const answer = await invoke<PullRequestLists>("pr-list-many", { workspaces: ["/tau", "/tau-worktree", "/tools", "/scratch", 7], state: "open", limit: 3 });
    expect(answer.lists.map((list) => [list.host, list.repo, list.workspaces, list.viewer, list.entries.length])).toEqual([
      ["github.com", "acme/tau", ["/tau", "/tau-worktree"], "niik", 3],
      ["gitlab.com", "acme/tools/tau", ["/tools"], "niik", 3],
    ]);
    expect(answer.failures).toEqual([{ workspace: "/scratch", message: "This project has no remote, so it has no pull requests to list." }]);
    expect(calls.filter((call) => call.args[0] === "pr" && call.args[1] === "list")).toHaveLength(1);
  });

  it("refuses a project without a remote it can read", async () => {
    const { invoke } = await harness({ remote: "work:acme/tau.git" });
    await expect(invoke("pr-list", {})).rejects.toThrow("names no server");
  });
});

describe("linked pull requests", () => {
  it("links by URL or number, keeps one link per request, and tells the window", async () => {
    const { invoke, events } = await harness();
    const first = await invoke<{ link: ThreadPullRequestLink; alreadyLinked: boolean }>("link-pr", { threadId: "t1", reference: GITHUB_URL });
    expect(first.alreadyLinked).toBe(false);
    expect(first.link).toMatchObject({ number: 7, repo: "acme/tau", source: "user", title: "Add the output helper", state: "open" });
    const again = await invoke<{ alreadyLinked: boolean }>("link-pr", { threadId: "t1", reference: "#7", cwd: "/project" });
    expect(again.alreadyLinked).toBe(true);
    await invoke("link-pr", { threadId: "t1", reference: "12" });
    expect((await invoke<ThreadPullRequestLink[]>("thread-links", { threadId: "t1" })).map((link) => link.url)).toEqual([GITHUB_URL, "https://github.com/acme/tau/pull/12"]);
    expect(events.filter((event) => event.name === THREAD_LINKS_EVENT)).toHaveLength(2);
    await expect(invoke("link-pr", { threadId: "t1", reference: "not a request" })).rejects.toThrow("Use a pull request URL");

    await expect(invoke("unlink-pr", { threadId: "t1", url: GITHUB_URL })).resolves.toEqual({ wasLinked: true });
    await expect(invoke("unlink-pr", { threadId: "t1", url: GITHUB_URL })).resolves.toEqual({ wasLinked: false });
    expect(await invoke<ThreadPullRequestLink[]>("thread-links", { threadId: "t1" })).toHaveLength(1);
  });

  it("names the threads that link a request and answers Thread Rail with each thread's states", async () => {
    const { invoke } = await harness();
    await invoke("link-pr", { threadId: "t1", reference: GITHUB_URL });
    await invoke("link-pr", { threadId: "t2", reference: "https://GitHub.com/ACME/tau/pull/7" });
    await invoke("link-pr", { threadId: "t2", reference: GITLAB_URL });
    await expect(invoke("pr-linked-threads", { url: GITHUB_URL })).resolves.toEqual(["t1", "t2"]);
    await expect(invoke("pr-linked-threads", { url: "https://github.com/acme/tau/pull/99" })).resolves.toEqual([]);
    await expect(invoke("thread-requests", { threadIds: ["t1", "t2", "t3", 4] })).resolves.toEqual({
      t1: [{ url: GITHUB_URL, state: "open" }],
      t2: [{ url: "https://github.com/ACME/tau/pull/7", state: "open" }, { url: GITLAB_URL, state: "open" }],
    });
  });

  it("keeps links to requests of every provider", async () => {
    const { invoke } = await harness();
    // No CLI answers for Codeberg here; the link is kept without a snapshot.
    await invoke("link-pr", { threadId: "t1", reference: "https://codeberg.org/acme/tau/pulls/3" });
    const stored = JSON.parse(await readFile(join(stateRoot!, REVIEW_HOST_EXTENSION_ID, "thread-pull-requests.json"), "utf8")) as { threads: Record<string, Array<{ service: string }>> };
    expect(stored.threads.t1).toEqual([expect.objectContaining({ service: "forgejo" })]);
  });

  it("keeps links across a restart and drops a deleted thread's", async () => {
    const first = await harness();
    await first.invoke("link-pr", { threadId: "t1", reference: GITHUB_URL });
    const stored = JSON.parse(await readFile(join(stateRoot!, REVIEW_HOST_EXTENSION_ID, "thread-pull-requests.json"), "utf8")) as { threads: Record<string, unknown[]> };
    expect(Object.keys(stored.threads)).toEqual(["t1"]);
    await first.lifecycles[0]!.threadDeleted!("t1", "/project");
    expect(await first.invoke<ThreadPullRequestLink[]>("thread-links", { threadId: "t1" })).toEqual([]);
  });

  it("asks every runtime to link each request it works on, in its system prompt", async () => {
    const { runtime, instructions } = await harness();
    const handlers = new Map<string, (event: { systemPrompt: string }) => unknown>();
    const pi = { registerTool: vi.fn(), on: (name: string, handler: (event: { systemPrompt: string }) => unknown) => { handlers.set(name, handler); } };
    runtime[0]!(pi as never, { sessionId: "thread-1", cwd: "/project" } as never);
    expect(pi.registerTool).toHaveBeenCalledTimes(3);
    const turn = handlers.get("before_agent_start")!({ systemPrompt: "You are Pi." }) as { systemPrompt: string };
    expect(turn.systemPrompt).toMatch(/^You are Pi\.\n\n<pull_request_linking>[\s\S]*call the link_pull_request tool with its full URL[\s\S]*<\/pull_request_linking>$/u);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!({ sessionId: "thread-2", cwd: "/elsewhere" })).toContain("list_thread_pull_requests");
  });

  it("gives every runtime the agent's link tools, bound to the calling thread", async () => {
    const { tool, invoke, runtime } = await harness();
    expect(runtime).toHaveLength(1);
    const linked = await tool("link_pull_request")({ number: 7 });
    expect(linked.details).toEqual({ host: "github.com", repository: "acme/tau", number: 7, url: GITHUB_URL, alreadyLinked: false });
    expect((await tool("link_pull_request")({ url: GITHUB_URL })).details).toMatchObject({ alreadyLinked: true });
    const listed = await tool("list_thread_pull_requests")({});
    expect(listed.details).toMatchObject({ pullRequests: [{ number: 7, source: "agent", state: "open" }] });
    // Another thread's credential sees none of it.
    expect((await tool("list_thread_pull_requests", { sessionId: "thread-2", cwd: "/project" })({})).details).toEqual({ pullRequests: [] });
    expect((await tool("unlink_pull_request")({ url: GITHUB_URL })).details).toMatchObject({ wasLinked: true });
    expect(await invoke("thread-links", { threadId: "thread-1" })).toEqual([]);
    await expect(tool("link_pull_request")({})).rejects.toThrow("Pass a pull request URL, or its number.");
  });
});

describe("reviews", () => {
  it("submits a GitHub review with its verdict and held line comments in one call", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-review", { url: GITHUB_URL, event: "request-changes", body: "Two things.", comments: [{ id: "p1", path: "src/output.ts", line: 3, side: "new", body: "Rename this." }] });
    const review = calls.find((call) => call.args.includes(`repos/acme/tau/pulls/7/reviews`))!;
    expect(review.args).toEqual(expect.arrayContaining(["--method", "POST", "--input", "-"]));
    expect(JSON.parse(review.input!)).toEqual({
      commit_id: expect.any(String),
      event: "REQUEST_CHANGES",
      body: "Two things.",
      comments: [{ path: "src/output.ts", line: 3, side: "RIGHT", body: "Rename this." }],
    });
    await expect(invoke("pr-review", { url: GITHUB_URL, event: "comment", body: " " })).rejects.toThrow("Write a comment");
    await expect(invoke("pr-review", { url: GITHUB_URL, event: "approve" })).resolves.toMatchObject({ title: "Add the output helper" });
  });

  it("approves on GitLab after posting the comments, and refuses a request for changes", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-review", { url: GITLAB_URL, event: "approve", body: "Looks good.", comments: [{ path: "a.ts", line: 2, side: "new", body: "nit" }] });
    const writes = calls.filter((call) => call.args.includes("--method")).map((call) => call.args.at(-1));
    expect(writes).toEqual([
      "projects/acme%2Ftools%2Ftau/merge_requests/12/discussions",
      "projects/acme%2Ftools%2Ftau/merge_requests/12/notes",
      "projects/acme%2Ftools%2Ftau/merge_requests/12/approve",
    ]);
    await expect(invoke("pr-review", { url: GITLAB_URL, event: "request-changes", body: "No." })).rejects.toThrow("GitLab takes no request for changes");
  });

  it("resolves and reopens a conversation", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-resolve", { url: GITHUB_URL, threadId: "PRRT_1", resolved: true });
    expect(JSON.parse(calls.find((call) => call.input?.includes("resolveReviewThread"))!.input!).variables).toEqual({ threadId: "PRRT_1" });
    await invoke("pr-resolve", { url: GITHUB_URL, threadId: "PRRT_1", resolved: false });
    expect(calls.some((call) => call.input?.includes("unresolveReviewThread"))).toBe(true);
    await invoke("pr-resolve", { url: GITLAB_URL, threadId: "abc", resolved: true });
    const gitlab = calls.find((call) => call.args.at(-1)?.endsWith("/discussions/abc"))!;
    expect(gitlab.args).toEqual(expect.arrayContaining(["--method", "PUT"]));
    expect(JSON.parse(gitlab.input!)).toEqual({ resolved: true });
  });

  it("edits each kind of comment with its own call", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-edit-comment", { url: GITHUB_URL, id: "IC_1", kind: "comment", body: "Fixed" });
    await invoke("pr-edit-comment", { url: GITHUB_URL, id: "PRR_2", kind: "review", body: "Fixed" });
    await invoke("pr-edit-comment", { url: GITHUB_URL, id: "PRRC_3", kind: "review-comment", body: "Fixed" });
    const mutations = calls.filter((call) => call.input).map((call) => /\{ (\w+)\(/u.exec(JSON.parse(call.input!).query as string)?.[1]);
    expect(mutations).toEqual(["updateIssueComment", "updatePullRequestReview", "updatePullRequestReviewComment"]);
    await invoke("pr-edit-comment", { url: GITLAB_URL, id: "42", kind: "comment", body: "Fixed" });
    expect(calls.at(-1)!.args.at(-1)).toBe("projects/acme%2Ftools%2Ftau/merge_requests/12/notes/42");
    await expect(invoke("pr-edit-comment", { url: GITHUB_URL, id: "IC_1", kind: "comment", body: "" })).rejects.toThrow("cannot be empty");
  });

  it("changes reviewers and labels through each CLI", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-reviewers", { url: GITHUB_URL, add: ["mona", "hubot"], remove: ["octo"] });
    expect(calls.find((call) => call.args[1] === "edit")!.args).toEqual(["pr", "edit", GITHUB_URL, "--add-reviewer", "mona,hubot", "--remove-reviewer", "octo"]);
    await invoke("pr-labels", { url: GITHUB_URL, add: ["bug"], remove: [] });
    expect(calls.filter((call) => call.args[1] === "edit").at(-1)!.args).toEqual(["pr", "edit", GITHUB_URL, "--add-label", "bug"]);
    await invoke("pr-reviewers", { url: GITLAB_URL, add: ["mona"], remove: ["octo"] });
    expect(calls.find((call) => call.args[0] === "mr")!.args).toEqual(["mr", "update", "12", "--repo", "https://gitlab.com/acme/tools/tau", "--yes", "--reviewer=+mona", "--reviewer=-octo"]);
    await invoke("pr-labels", { url: GITLAB_URL, add: ["bug"], remove: ["wip"] });
    expect(JSON.parse(calls.find((call) => call.input?.includes("add_labels"))!.input!)).toEqual({ add_labels: "bug", remove_labels: "wip" });
    await expect(invoke("pr-labels", { url: GITHUB_URL, add: [], remove: [] })).rejects.toThrow("Nothing to change");
  });

  it("offers the repository's labels and who can review", async () => {
    const { invoke } = await harness({
      answer: ({ args }) => {
        if (args[0] === "label") return JSON.stringify([{ name: "bug", color: "d73a4a" }, { name: "docs", color: "zzz" }]);
        if (args.some((arg) => arg.includes("assignableUsers"))) return JSON.stringify({ data: { repository: { assignableUsers: { nodes: [{ login: "mona" }, { login: "hubot" }] } } } });
        return undefined;
      },
    });
    await expect(invoke("pr-candidates", { url: GITHUB_URL })).resolves.toEqual({ labels: [{ name: "bug", color: "d73a4a" }, { name: "docs" }], reviewers: ["mona", "hubot"] });
  });

  it("names the signed-in account on the request, so only its own comments are offered for editing", async () => {
    const { invoke } = await harness({ viewer: "octo" });
    await expect(invoke<PullRequestDetail>("pr-view", { url: GITHUB_URL })).resolves.toMatchObject({ viewer: "octo" });
  });
});

describe("long requests", () => {
  it("reads every page of GitHub's conversations and viewed marks", async () => {
    const page = (threads: string[], threadsNext: string | undefined, files: string[] | undefined, filesNext?: string) => JSON.stringify({
      data: { repository: { pullRequest: {
        id: "PR_1",
        reviewThreads: { pageInfo: { hasNextPage: Boolean(threadsNext), endCursor: threadsNext ?? null }, nodes: threads.map((id) => ({ id, path: "a.ts", line: 1, diffSide: "RIGHT", comments: { nodes: [] } })) },
        ...(files ? { files: { pageInfo: { hasNextPage: Boolean(filesNext), endCursor: filesNext ?? null }, nodes: files.map((path) => ({ path, viewerViewedState: "VIEWED" })) } } : {}),
      } } },
    });
    const { invoke, calls } = await harness({
      answer: ({ args }) => {
        if (!args.includes("graphql")) return undefined;
        if (args.includes("threadsAfter=c1")) return page(["T3"], undefined, undefined);
        return page(["T1", "T2"], "c1", ["a.ts"]);
      },
    });
    const threads = await invoke<PullRequestThread[]>("pr-comments", { url: GITHUB_URL });
    expect(threads.map((thread) => thread.id)).toEqual(["T1", "T2", "T3"]);
    const second = calls.filter((call) => call.args.includes("graphql"))[1]!.args;
    expect(second).toEqual(expect.arrayContaining(["withThreads=true", "withFiles=false", "threadsAfter=c1"]));
  });

  it("falls back to GitHub's per-file listing when the diff is refused as too large", async () => {
    const { invoke, calls } = await harness({
      answer: ({ args }) => {
        if (args[0] === "pr" && args[1] === "diff") throw new Error("could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).");
        if (args.includes("--paginate")) {
          return [
            JSON.stringify({ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }),
            JSON.stringify({ filename: "src/big.json", status: "added", additions: 90000, deletions: 0 }),
            JSON.stringify({ filename: "src/b.ts", previous_filename: "src/c.ts", status: "renamed", additions: 0, deletions: 0 }),
          ].join("\n");
        }
        return undefined;
      },
    });
    const files = await invoke<PullRequestFiles>("pr-files", { url: GITHUB_URL });
    expect(calls.some((call) => call.args.includes("repos/acme/tau/pulls/7/files?per_page=100"))).toBe(true);
    expect(files.files.map((file) => [file.path, file.status, file.added, file.removed, file.previousPath])).toEqual([
      ["src/a.ts", "modified", 1, 1, undefined],
      ["src/big.json", "added", 90000, 0, undefined],
      ["src/b.ts", "renamed", 0, 0, "src/c.ts"],
    ]);
    expect(files.diffs[1]!.note).toContain("too large");
  });

  it("pages GitLab's diffs and discussions past 100", async () => {
    const hundred = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ old_path: `f${index}.ts`, new_path: `f${index}.ts`, diff: "@@ -1 +1 @@\n-a\n+b" })));
    const { invoke, calls } = await harness({
      answer: ({ args }) => {
        const path = args.at(-1) ?? "";
        if (path.includes("/diffs?") && path.endsWith("page=1")) return hundred;
        if (path.includes("/diffs?")) return JSON.stringify([{ old_path: "last.ts", new_path: "last.ts", diff: "@@ -1 +1 @@\n-a\n+b" }]);
        return undefined;
      },
    });
    const files = await invoke<PullRequestFiles>("pr-files", { url: GITLAB_URL });
    expect(files.files).toHaveLength(101);
    expect(calls.filter((call) => call.args.at(-1)?.includes("/diffs?")).map((call) => call.args.at(-1)!.split("page=").at(-1))).toEqual(["1", "2"]);
  });
});
