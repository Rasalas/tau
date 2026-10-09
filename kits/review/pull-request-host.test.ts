import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type PullRequestDetail, type PullRequestFiles, type ThreadPullRequestLink } from "./protocol.js";
import {
  parseGitHubDetail,
  parseGitHubThreads,
  parseGitLabDetail,
  parseGitLabDiffs,
  parseGitLabThreads,
  parseRequestUrl,
  parseUnifiedDiff,
} from "./pull-request-json.js";
import type { CliRunOptions } from "./request-cli.js";
import { LINK_SEAMS } from "./test-seams.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");

const RECORDED = parseRequestUrl("https://github.com/Rasalas/tau/pull/14")!;
const GITHUB = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const GITLAB = parseRequestUrl("https://gitlab.com/acme/tools/tau/-/merge_requests/12")!;

describe("pull request URLs", () => {
  it("reads GitHub and GitLab request URLs, nested groups and enterprise hosts included", () => {
    expect(GITHUB).toEqual({ service: "github", host: "github.com", repo: "acme/tau", number: 7, url: "https://github.com/acme/tau/pull/7" });
    expect(GITLAB).toEqual({ service: "gitlab", host: "gitlab.com", repo: "acme/tools/tau", number: 12, url: "https://gitlab.com/acme/tools/tau/-/merge_requests/12" });
    expect(parseRequestUrl("https://git.example.com/a/b/pull/3/")).toMatchObject({ host: "git.example.com", repo: "a/b", number: 3 });
    expect(parseRequestUrl("https://github.com/acme/tau/issues/7")).toBeUndefined();
    expect(parseRequestUrl("file:///etc/passwd")).toBeUndefined();
    expect(parseRequestUrl("not a url")).toBeUndefined();
  });
});

describe("gh fixtures", () => {
  it("reads a recorded `gh pr view` of a merged request", async () => {
    const detail = parseGitHubDetail(RECORDED, await fixture("gh-pr-view.json"));
    expect(detail).toMatchObject({
      nodeId: "PR_kwDOUIZxU88AAAABD5tuPA",
      title: "feat(terminal): ship the Terminal Kit with a host seam for native dependencies",
      state: "merged",
      draft: false,
      author: { login: "Rasalas", name: "Torben Buck" },
      baseRef: "main",
      headRef: "feat/02-terminal-kit",
      additions: 1437,
      deletions: 10,
      changedFiles: 31,
      reviewers: [],
      labels: [],
      comments: [],
    });
    expect(detail.checks.map((check) => `${check.name}:${check.status}`)).toEqual(["fast:passed", "performance:passed", "smoke:passed"]);
    expect(detail.commits).toEqual([expect.objectContaining({ oid: "d3d07dddc7c34ff3aecb4434d446871d074d6720", author: "Rasalas" })]);
  });

  it("reads reviewers, labels, comments and every kind of check", async () => {
    const detail = parseGitHubDetail(GITHUB, await fixture("gh-pr-view-discussed.json"));
    expect(detail.reviewers).toEqual([
      { login: "hubot", verdict: "pending" },
      { login: "core", verdict: "pending", team: true },
      { login: "mona", verdict: "changes-requested" },
    ]);
    expect(detail.labels).toEqual([{ name: "enhancement", color: "a2eeef" }, { name: "terminal" }]);
    // The bodiless "commented" review is only the envelope of its line comments.
    expect(detail.comments.map((comment) => [comment.id, comment.kind, comment.author.login, comment.author.bot ?? false])).toEqual([
      ["IC_1", "comment", "octo", false],
      ["IC_2", "comment", "ci-bot[bot]", true],
      ["PRR_2", "review", "mona", false],
    ]);
    expect(detail.comments[2]!.verdict).toBe("changes-requested");
    expect(detail.checks.map((check) => `${check.name}:${check.status}`)).toEqual(["fast:passed", "smoke:failed", "performance:pending", "coverage:passed"]);
    expect(detail.checks.find((check) => check.name === "coverage")).toMatchObject({ url: "https://coverage.example/7", description: "91% covered" });
  });

  it("reads review threads and viewed marks from the GraphQL answer", async () => {
    const recorded = parseGitHubThreads(await fixture("gh-pr-threads.json"));
    expect(recorded.threads).toEqual([]);
    expect(recorded.nodeId).toBe("PR_kwDOUIZxU88AAAABD5tuPA");
    expect([...recorded.viewed.values()].every((state) => state === "unviewed")).toBe(true);

    const discussed = parseGitHubThreads(await fixture("gh-pr-threads-discussed.json"));
    expect(discussed.threads).toEqual([
      expect.objectContaining({ id: "PRRT_1", path: "kits/terminal/output.ts", line: 10, side: "new", resolved: false, outdated: false }),
      expect.objectContaining({ id: "PRRT_2", line: 3, resolved: true, outdated: true }),
    ]);
    expect(discussed.threads[0]!.comments.map((comment) => comment.author.login)).toEqual(["mona", "octo"]);
    expect(discussed.threads[1]!.comments[0]!.author.login).toBe("ghost");
    expect(discussed.viewed.get("kits/terminal/output.ts")).toBe("dismissed");
  });

  it("splits a recorded `gh pr diff` into files whose counts match what `gh pr view` says", async () => {
    const entries = parseUnifiedDiff(await fixture("gh-pr-diff.patch"));
    const view = JSON.parse(await fixture("gh-pr-view.json")) as { files: Array<{ path: string; additions: number; deletions: number; changeType: string }> };
    expect(entries.map((entry) => entry.file.path)).toEqual(view.files.map((file) => file.path));
    for (const file of view.files) {
      const entry = entries.find((candidate) => candidate.file.path === file.path)!;
      expect([entry.file.added, entry.file.removed]).toEqual([file.additions, file.deletions]);
      expect(entry.file.status).toBe(file.changeType === "ADDED" ? "added" : "modified");
    }
    const output = entries.find((entry) => entry.file.path === "kits/terminal/output.ts")!.diff;
    expect(output.hunks[0]!.lines[0]).toEqual({ kind: "added", newLine: 1, text: "import type { TerminalDataEvent } from \"./protocol.js\";" });
  });

  it("reads renames, deletions and binary files", () => {
    const entries = parseUnifiedDiff([
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-was",
      "+is",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "\\ No newline at end of file",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n"));
    expect(entries.map((entry) => entry.file)).toEqual([
      { path: "new.ts", previousPath: "old.ts", status: "renamed", added: 1, removed: 1 },
      { path: "gone.ts", status: "deleted", added: 0, removed: 1 },
      { path: "logo.png", status: "modified", added: 0, removed: 0 },
    ]);
    expect(entries[0]!.diff.hunks[0]!.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "keep" },
      { kind: "removed", oldLine: 2, text: "was" },
      { kind: "added", newLine: 2, text: "is" },
    ]);
    expect(entries[2]!.diff.note).toBe("Binary file");
  });
});

describe("glab fixtures", () => {
  it("reads a merge request with its discussions, approvals, pipeline and commits", async () => {
    const detail = parseGitLabDetail(GITLAB, await fixture("glab-mr.json"), await fixture("glab-discussions.json"), await fixture("glab-commits.json"));
    expect(detail).toMatchObject({
      title: "Draft: Add the output helper",
      state: "open",
      draft: true,
      baseRef: "main",
      headRef: "feat/output",
      changedFiles: 1,
      diffRefs: { base: "1111111111111111111111111111111111111111", head: "abcdef0123456789abcdef0123456789abcdef01", start: "2222222222222222222222222222222222222222" },
      labels: [{ name: "enhancement" }, { name: "terminal" }],
      reviewers: [{ login: "mona", verdict: "approved" }, { login: "hubot", verdict: "pending" }],
      checks: [{ name: "Pipeline", status: "pending", description: "running", url: "https://gitlab.com/acme/tools/tau/-/pipelines/77" }],
      commits: [{ oid: "abcdef0123456789abcdef0123456789abcdef01", headline: "feat(terminal): add the output helper", author: "Octo Cat", committedAt: "2026-09-20T07:56:00.000Z" }],
    });
    // System notes and line notes stay out of the conversation.
    expect(detail.comments.map((comment) => comment.body)).toEqual(["Ready for a look."]);
  });

  it("reads line discussions as threads and the diffs endpoint as files", async () => {
    expect(parseGitLabThreads(await fixture("glab-discussions.json"))).toEqual([
      expect.objectContaining({ id: "d3", path: "kits/terminal/output.ts", line: 10, side: "new", resolved: false }),
    ]);
    const [entry] = parseGitLabDiffs(await fixture("glab-diffs.json"));
    expect(entry!.file).toEqual({ path: "kits/terminal/output.ts", status: "added", added: 13, removed: 0 });
  });
});

interface Call { args: string[]; input?: string }

let stateRoot: string | undefined;
afterEach(async () => { if (stateRoot) await rm(stateRoot, { recursive: true, force: true }); stateRoot = undefined; });

/** Review Kit's host entry over a fake `gh`/`glab` that answers from the fixtures and records every call. */
async function harness(options: { tools?: Record<string, string>; answer?(call: Call): string | Promise<string> } = {}) {
  stateRoot = await mkdtemp(join(tmpdir(), "tau-pr-view-"));
  const calls: Call[] = [];
  const run = vi.fn(async (_command: string, args: string[], _cwd: string, runOptions?: CliRunOptions) => {
    const call: Call = { args, ...(runOptions?.input !== undefined ? { input: runOptions.input } : {}) };
    // Who is signed in is asked once per host; the tests count the request's own calls.
    if (args[0] === "api" && args.at(-1) === "user") return JSON.stringify({ login: "octo" });
    calls.push(call);
    if (options.answer) return options.answer(call);
    return defaultAnswer(call);
  });
  const tools = options.tools ?? { gh: "/bin/gh", glab: "/bin/glab" };
  const registry = await activateHostKit(createReviewHostExtension({ run }), {
    ...LINK_SEAMS,
    findCommand: (name: string) => tools[name],
    noteSubprocess: () => undefined,
    stateDir: stateRoot,
  });
  const invoke = <T = unknown>(command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input) as Promise<T>;
  return { invoke, calls, run };
}

async function defaultAnswer({ args }: Call): Promise<string> {
  const joined = args.join(" ");
  if (joined.startsWith("pr view") && joined.endsWith("statusCheckRollup")) return fixture("gh-pr-view-discussed.json");
  if (joined.startsWith("pr view")) return fixture("gh-pr-view-discussed.json");
  if (joined.startsWith("pr diff")) return fixture("gh-pr-diff.patch");
  if (args[0] === "api" && args.includes("graphql") && args.some((arg) => arg.startsWith("query="))) return fixture("gh-pr-threads-discussed.json");
  if (args[0] === "api" && args.at(-1)?.includes("/discussions?")) return fixture("glab-discussions.json");
  if (args[0] === "api" && args.at(-1)?.includes("/commits?")) return fixture("glab-commits.json");
  if (args[0] === "api" && args.at(-1)?.includes("/diffs?")) return fixture("glab-diffs.json");
  if (args[0] === "api" && args.at(-1)?.endsWith("/merge_requests/12")) return fixture("glab-mr.json");
  return "{}";
}

describe("pull request commands", () => {
  it("reads a request once a minute unless asked for a fresh copy", async () => {
    const { invoke, calls } = await harness();
    const first = await invoke<PullRequestDetail>("pr-view", { url: GITHUB.url });
    expect(first.title).toBe("Add the output helper");
    await invoke("pr-view", { url: GITHUB.url });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 4)).toEqual(["pr", "view", GITHUB.url, "--json"]);
    await invoke("pr-view", { url: GITHUB.url, fresh: true });
    expect(calls).toHaveLength(2);
  });

  it("shares the conversations and viewed marks during a fresh view refresh", async () => {
    const graph = await fixture("gh-pr-threads-discussed.json");
    let finish!: (value: string) => void;
    const waiting = new Promise<string>((resolve) => { finish = resolve; });
    const { invoke, calls } = await harness({ answer: (call) =>
      call.args.includes("graphql") ? waiting : defaultAnswer(call) });
    const reads = [
      invoke("pr-view", { url: GITHUB.url, fresh: true }),
      invoke("pr-comments", { url: GITHUB.url, fresh: true }),
      invoke("pr-files", { url: GITHUB.url, fresh: true }),
    ];
    await vi.waitFor(() => expect(calls.some((call) => call.args[1] === "diff")).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish(graph);
    await Promise.all(reads);
    expect(calls).toHaveLength(3);
    await invoke("pr-comments", { url: GITHUB.url, fresh: true });
    expect(calls.filter((call) => call.args.includes("graphql"))).toHaveLength(2);
  });

  it("does not join an older ordinary read when a fresh conversation read is requested", async () => {
    const graph = await fixture("gh-pr-threads-discussed.json");
    let finish!: (value: string) => void;
    const waiting = new Promise<string>((resolve) => { finish = resolve; });
    let graphs = 0;
    const { invoke } = await harness({ answer: (call) => {
      if (call.args.includes("graphql")) return ++graphs === 1 ? waiting : graph;
      return defaultAnswer(call);
    } });
    const old = invoke("pr-comments", { url: GITHUB.url });
    await vi.waitFor(() => expect(graphs).toBe(1));
    await invoke("pr-comments", { url: GITHUB.url, fresh: true });
    expect(graphs).toBe(2);
    finish(graph);
    await old;
  });

  it("starts a new conversation read after a mutation while an older refresh is pending", async () => {
    const graph = await fixture("gh-pr-threads-discussed.json");
    let finish!: (value: string) => void;
    const waiting = new Promise<string>((resolve) => { finish = resolve; });
    let graphs = 0;
    const { invoke, calls } = await harness({ answer: (call) => {
      if (call.args.includes("graphql")) return ++graphs === 1 ? waiting : graph;
      return defaultAnswer(call);
    } });
    const old = invoke("pr-comments", { url: GITHUB.url, fresh: true });
    await vi.waitFor(() => expect(graphs).toBe(1));
    await invoke("pr-comment", { url: GITHUB.url, body: "New information" });
    await invoke("pr-comments", { url: GITHUB.url, fresh: true });
    expect(graphs).toBe(2);
    finish(graph);
    await old;
    await invoke("pr-comments", { url: GITHUB.url });
    expect(calls.filter((call) => call.args.includes("graphql"))).toHaveLength(2);
  });

  it("does not share refreshes between GitHub endpoints or keep a failed refresh", async () => {
    const graph = await fixture("gh-pr-threads-discussed.json");
    let fail!: (error: Error) => void;
    const waiting = new Promise<string>((_resolve, reject) => { fail = reject; });
    let graphs = 0;
    const { invoke } = await harness({ answer: (call) => {
      if (call.args.includes("graphql")) return ++graphs <= 2 ? waiting : graph;
      return defaultAnswer(call);
    } });
    const reads = Promise.allSettled([
      invoke("pr-comments", { url: GITHUB.url, fresh: true }),
      invoke("pr-comments", { url: "https://github.example.com/acme/tau/pull/7", fresh: true }),
    ]);
    await vi.waitFor(() => expect(graphs).toBe(2));
    fail(new Error("HTTP 401: Bad credentials"));
    expect((await reads).every((result) => result.status === "rejected")).toBe(true);
    await invoke("pr-comments", { url: GITHUB.url, fresh: true });
    expect(graphs).toBe(3);
  });

  it("records what the view read in every thread that links the request", async () => {
    let state = "OPEN";
    const { invoke, calls } = await harness({ answer: async (call) => {
      if (call.args.slice(0, 2).join(" ") !== "pr view") return defaultAnswer(call);
      return JSON.stringify({ ...JSON.parse(await fixture("gh-pr-view-discussed.json")), state });
    } });
    for (const threadId of ["a", "b"]) await invoke("link-pr", { threadId, reference: GITHUB.url });
    const stateOf = async (threadId: string) => (await invoke<ThreadPullRequestLink[]>("thread-links", { threadId }))[0]?.state;
    expect(await stateOf("a")).toBe("open");
    state = "MERGED";
    await invoke("pr-view", { url: GITHUB.url, fresh: true });
    const views = calls.filter((call) => call.args[1] === "view").length;
    await vi.waitFor(async () => expect([await stateOf("a"), await stateOf("b")]).toEqual(["merged", "merged"]));
    expect(calls.filter((call) => call.args[1] === "view")).toHaveLength(views);
  });

  it("refuses anything that is not a request URL, and says which CLI is missing", async () => {
    const { invoke } = await harness({ tools: {} });
    await expect(invoke("pr-view", { url: "https://github.com/acme/tau" })).rejects.toThrow(/by its URL/u);
    await expect(invoke("pr-view", { url: GITHUB.url })).rejects.toThrow(/GitHub CLI \(gh\) is not installed/u);
    await expect(invoke("pr-view", { url: GITLAB.url })).rejects.toThrow(/GitLab CLI \(glab\) is not installed/u);
  });

  it("explains a failed read in the tool's own words", async () => {
    const { invoke } = await harness({ answer: () => { throw new Error("HTTP 401: Bad credentials"); } });
    await expect(invoke("pr-view", { url: GITHUB.url })).rejects.toThrow(/not signed in. Run `gh auth login`/u);
  });

  it("answers the files with their diffs and GitHub's viewed marks", async () => {
    const { invoke } = await harness();
    const files = await invoke<PullRequestFiles>("pr-files", { url: GITHUB.url });
    expect(files.viewedOn).toBe("host");
    expect(files.files.find((file) => file.path === "kits/terminal/output.ts")).toMatchObject({ status: "added", added: 13, viewed: "dismissed" });
    expect(files.files.find((file) => file.path === "README.md")!.viewed).toBe("unviewed");
    expect(files.diffs).toHaveLength(files.files.length);
  });

  it("reads checks fresh every time", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-checks", { url: GITHUB.url });
    const checks = await invoke<Array<{ status: string }>>("pr-checks", { url: GITHUB.url });
    expect(checks.map((check) => check.status)).toEqual(["passed", "failed", "pending", "passed"]);
    expect(calls).toHaveLength(2);
  });

  it("posts a comment, a reply and a line comment with the text on stdin, and drops the cache", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-view", { url: GITHUB.url });
    await invoke("pr-comment", { url: GITHUB.url, body: "  Looks good.  " });
    expect(calls.at(-1)).toEqual({ args: ["pr", "comment", GITHUB.url, "--body-file", "-"], input: "Looks good." });

    await invoke("pr-comment", { url: GITHUB.url, threadId: "PRRT_1", body: "Renamed it." });
    const reply = calls.at(-1)!;
    expect(reply.args).toEqual(["api", "--hostname", "github.com", "graphql", "--input", "-"]);
    expect(JSON.parse(reply.input!)).toMatchObject({ query: expect.stringContaining("addPullRequestReviewThreadReply"), variables: { threadId: "PRRT_1", body: "Renamed it." } });

    await invoke("pr-comment", { url: GITHUB.url, path: "kits/terminal/output.ts", line: 10, side: "new", body: "Name this." });
    const line = calls.at(-1)!;
    expect(line.args).toEqual(["api", "--hostname", "github.com", "--method", "POST", "repos/acme/tau/pulls/7/comments", "--input", "-"]);
    expect(JSON.parse(line.input!)).toEqual({ body: "Name this.", commit_id: "0123456789abcdef0123456789abcdef01234567", path: "kits/terminal/output.ts", line: 10, side: "RIGHT" });

    const before = calls.length;
    await invoke("pr-view", { url: GITHUB.url });
    expect(calls.length).toBe(before + 1);
    await expect(invoke("pr-comment", { url: GITHUB.url, body: "  " })).rejects.toThrow(/Write a comment/u);
  });

  it("edits the title and the body, and answers the request as it is now", async () => {
    const { invoke, calls } = await harness();
    const detail = await invoke<PullRequestDetail>("pr-update", { url: GITHUB.url, title: " New title ", body: "New body" });
    expect(calls[0]).toEqual({ args: ["pr", "edit", GITHUB.url, "--title", "New title", "--body-file", "-"], input: "New body" });
    expect(calls[1]!.args.slice(0, 2)).toEqual(["pr", "view"]);
    expect(detail.ref.url).toBe(GITHUB.url);
    await expect(invoke("pr-update", { url: GITHUB.url, title: " " })).rejects.toThrow(/title is required/u);
    await expect(invoke("pr-update", { url: GITHUB.url })).rejects.toThrow(/Nothing to change/u);
  });

  it("marks a file viewed on GitHub with the request's node id", async () => {
    const { invoke, calls } = await harness();
    await expect(invoke("pr-viewed", { url: GITHUB.url, path: "README.md", viewed: true })).resolves.toEqual({ viewed: "viewed" });
    const mark = calls.at(-1)!;
    expect(mark.args).toEqual(["api", "--hostname", "github.com", "graphql", "--input", "-"]);
    expect(JSON.parse(mark.input!)).toMatchObject({ query: expect.stringContaining("markFileAsViewed"), variables: { pullRequestId: "PR_kwDOAcme0000000007", path: "README.md" } });
    await invoke("pr-viewed", { url: GITHUB.url, path: "README.md", viewed: false });
    expect(JSON.parse(calls.at(-1)!.input!).query).toContain("unmarkFileAsViewed");
  });

  it("keeps GitLab's viewed marks in the kit's own store until the file changes", async () => {
    let diffs = await fixture("glab-diffs.json");
    const { invoke } = await harness({ answer: async (call) => call.args.at(-1)?.includes("/diffs?") ? diffs : defaultAnswer(call) });
    const path = "kits/terminal/output.ts";
    expect((await invoke<PullRequestFiles>("pr-files", { url: GITLAB.url })).viewedOn).toBe("local");
    await invoke("pr-viewed", { url: GITLAB.url, path, viewed: true });
    expect((await invoke<PullRequestFiles>("pr-files", { url: GITLAB.url })).files[0]!.viewed).toBe("viewed");
    const stored = JSON.parse(await readFile(join(stateRoot!, REVIEW_HOST_EXTENSION_ID, "viewed-files.json"), "utf8")) as { version: number; requests: Record<string, unknown> };
    expect(Object.keys(stored.requests)).toEqual([GITLAB.url]);

    diffs = diffs.replace("export function unseenOutput", "export function unseenChunk");
    expect((await invoke<PullRequestFiles>("pr-files", { url: GITLAB.url, fresh: true })).files[0]!.viewed).toBe("dismissed");
    await expect(invoke("pr-viewed", { url: GITLAB.url, path: "nope.ts", viewed: true })).rejects.toThrow(/not part of MR #12/u);
  });

  it("writes to GitLab through its API with JSON on stdin", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-comment", { url: GITLAB.url, threadId: "d3", body: "Done." });
    expect(calls.at(-1)).toEqual({
      args: ["api", "--hostname", "gitlab.com", "--method", "POST", "--header", "Content-Type: application/json", "--input", "-", "projects/acme%2Ftools%2Ftau/merge_requests/12/discussions/d3/notes"],
      input: JSON.stringify({ body: "Done." }),
    });
    await invoke("pr-comment", { url: GITLAB.url, path: "kits/terminal/output.ts", line: 4, side: "new", body: "Here." });
    expect(JSON.parse(calls.at(-1)!.input!)).toEqual({
      body: "Here.",
      position: {
        position_type: "text",
        base_sha: "1111111111111111111111111111111111111111",
        head_sha: "abcdef0123456789abcdef0123456789abcdef01",
        start_sha: "2222222222222222222222222222222222222222",
        new_path: "kits/terminal/output.ts",
        old_path: "kits/terminal/output.ts",
        new_line: 4,
      },
    });
    await invoke("pr-update", { url: GITLAB.url, body: "Replays once, now." });
    const edit = calls.find((call) => call.args.includes("PUT"))!;
    expect(edit.args.at(-1)).toBe("projects/acme%2Ftools%2Ftau/merge_requests/12");
    expect(JSON.parse(edit.input!)).toEqual({ description: "Replays once, now." });
  });
});

