import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type PullRequestDetail, type PullRequestFiles, type PullRequestList, type PullRequestThread, type ReviewRequestContext, type ReviewRequestStatus } from "./protocol.js";
import { forgejoRepository, loginFor, parseTeaLogins } from "./provider-forgejo.js";
import type { CliRunOptions } from "./request-cli.js";
import { LINK_SEAMS } from "./test-seams.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const API = "https://codeberg.org/api/v1/repos/forgejo/forgejo";
const URL_14486 = "https://codeberg.org/forgejo/forgejo/pulls/14486";
const TITLE_14535 = "Fix LFS raw file test, add additional cases";

interface Call { args: string[]; input?: string }

const stateRoots: string[] = [];
afterEach(async () => { await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** The recorded Codeberg answers by path; anything written answers `{}`. */
async function answer(url: string, method: string): Promise<{ status: number; body: string }> {
  const path = url.replace(API, "");
  if (method !== "GET") return { status: 201, body: path.endsWith("/pulls") ? JSON.stringify({ html_url: "https://codeberg.org/forgejo/forgejo/pulls/14600" }) : "{}" };
  if (url.endsWith("/api/v1/user")) return { status: 200, body: JSON.stringify({ login: "Gusted" }) };
  if (path.startsWith("/pulls?")) return { status: 200, body: await fixture("forgejo-pulls.json") };
  if (path === "/pulls/14486") return { status: 200, body: await fixture("forgejo-pull.json") };
  if (path === "/pulls/14486.diff") return { status: 200, body: await fixture("forgejo-pull.diff") };
  if (path.startsWith("/pulls/14486/reviews/1894897/comments")) return { status: 200, body: await fixture("forgejo-review-comments.json") };
  if (path.startsWith("/pulls/14486/reviews")) return { status: 200, body: await fixture("forgejo-reviews.json") };
  if (path.startsWith("/pulls/14486/commits")) return { status: 200, body: await fixture("forgejo-commits.json") };
  if (path === "/issues/14486/comments") return { status: 200, body: await fixture("forgejo-comments.json") };
  if (path.startsWith("/commits/")) return { status: 200, body: await fixture("forgejo-status.json") };
  return { status: 200, body: "[]" };
}

/** Review Kit over a fake `tea` and a Workspace Kit that answers a Codeberg checkout. */
async function harness(options: { tools?: Record<string, string>; context?: Partial<ReviewRequestContext>; logins?: string; fail?(url: string, method: string): number | undefined } = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), "tau-forgejo-"));
  stateRoots.push(stateRoot);
  const calls: Call[] = [];
  const pushes = vi.fn();
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
      context.registerCommand("review-request-context", () => ({
        root: "/project", branch: "fix-lfs-raw-file-test", base: "forgejo",
        remote: { name: "origin", url: "https://codeberg.org/forgejo/forgejo.git" }, upstream: "origin/fix-lfs-raw-file-test", ahead: 0,
        ...options.context,
      }), callers);
      context.registerCommand("push", () => { pushes(); return {}; }, callers);
    },
  };
  const run = vi.fn(async (_command: string, args: string[], _cwd: string, runOptions?: CliRunOptions) => {
    if (args[0] === "login") return options.logins ?? fixture("tea-logins.json");
    const call: Call = { args, ...(runOptions?.input !== undefined ? { input: runOptions.input } : {}) };
    const url = args.at(-1)!;
    const method = args[args.indexOf("--method") + 1]!;
    if (!url.endsWith("/api/v1/user")) calls.push(call);
    const failed = options.fail?.(url, method);
    const reply = failed ? { status: failed, body: JSON.stringify({ message: "denied" }) } : await answer(url, method);
    runOptions?.onStderr?.(`HTTP/2.0 ${reply.status} OK\ncontent-type: application/json\n`);
    return reply.body;
  });
  const tools = options.tools ?? { tea: "/bin/tea" };
  const registry = await activateHostKit(workspace, {
    ...LINK_SEAMS,
    findCommand: (name: string) => tools[name],
    noteSubprocess: () => undefined,
    stateDir: stateRoot,
    runtimeOwner: () => "tau",
  });
  await registry.activate(createReviewHostExtension({ run }));
  const invoke = <T = unknown>(command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input) as Promise<T>;
  return { invoke, calls, pushes };
}

describe("Forgejo remotes and tea logins", () => {
  it("keeps a web port, names an SSH server alone and matches tea's login for either", async () => {
    expect(forgejoRepository("https://git.example.com:3000/acme/tau.git")).toEqual({ host: "git.example.com:3000", repo: "acme/tau" });
    expect(forgejoRepository("git@codeberg.org:forgejo/forgejo.git")).toEqual({ host: "codeberg.org", repo: "forgejo/forgejo" });
    expect(forgejoRepository("https://codeberg.org/group/sub/repo")).toBeUndefined();
    const logins = parseTeaLogins(await fixture("tea-logins.json"));
    expect(loginFor(logins, "git.example.com:3000")?.name).toBe("work");
    expect(loginFor(logins, "git.example.com")?.name).toBe("work");
    expect(loginFor(logins, "codeberg.org")).toMatchObject({ name: "codeberg.org", default: true });
    expect(loginFor(logins, "gitea.com")).toBeUndefined();
  });
});

describe("the Forgejo provider through tea", () => {
  it("finds the branch's request and its checks on Codeberg", async () => {
    const { invoke, calls } = await harness();
    const status = await invoke<ReviewRequestStatus>("pr-status");
    expect(status).toMatchObject({ service: "forgejo", request: { provider: "forgejo", number: 14535, baseRef: "forgejo", state: "open", draft: false } });
    expect(status.problem).toBeUndefined();
    expect(calls[0]!.args).toEqual(["api", "--include", "--login", "codeberg.org", "--method", "GET", `${API}/pulls?state=all&sort=recentupdate&limit=50`]);
    // Skipped runs pass, as the rail counts them.
    expect(status.request?.checks).toEqual({ passed: 4, failed: 0, pending: 0, total: 4 });
  });

  it("names tea when it is missing and the login when tea has none for the server", async () => {
    expect((await (await harness({ tools: {} })).invoke<ReviewRequestStatus>("pr-status")).problem).toMatch(/Gitea CLI \(tea\) is not installed/u);
    expect((await (await harness({ logins: "[]" })).invoke<ReviewRequestStatus>("pr-status")).problem).toMatch(/not signed in. Run `tea login add`/u);
  });

  it("pushes, then creates a draft with the prefix Forgejo reads as one, and merges by the chosen method", async () => {
    const { invoke, calls, pushes } = await harness({ context: { branch: "feature/new" } });
    const created = await invoke<{ url?: string }>("pr-create", { title: "Add it", body: "Why", draft: true });
    expect(pushes).toHaveBeenCalledTimes(1);
    const post = calls.find((call) => call.args.includes("POST"))!;
    expect(post.args).toEqual(["api", "--include", "--login", "codeberg.org", "--method", "POST", "--data", "@-", `${API}/pulls`]);
    expect(JSON.parse(post.input!)).toEqual({ title: "WIP: Add it", body: "Why", base: "forgejo", head: "feature/new" });
    expect(created.url).toBe("https://codeberg.org/forgejo/forgejo/pulls/14600");

    const open = await harness();
    await open.invoke("pr-merge", { method: "rebase" });
    const merge = open.calls.find((call) => call.args.at(-1)!.endsWith("/pulls/14535/merge"))!;
    expect(JSON.parse(merge.input!)).toEqual({ Do: "rebase" });
    await open.invoke("pr-edit", { draft: true });
    const edit = open.calls.find((call) => call.args.includes("PATCH"))!;
    expect(JSON.parse(edit.input!)).toEqual({ title: `WIP: ${TITLE_14535}` });
  });

  it("reads a request with its reviews, comments, commits and statuses", async () => {
    const { invoke } = await harness();
    const detail = await invoke<PullRequestDetail>("pr-view", { url: URL_14486 });
    expect(detail).toMatchObject({ state: "merged", draft: false, baseRef: "forgejo", changedFiles: 2, additions: 5, deletions: 1, viewer: "Gusted" });
    expect(detail.reviewers).toEqual([{ login: "famfo-cb", verdict: "approved" }, { login: "Gusted", verdict: "approved" }]);
    expect(detail.labels.map((label) => label.name)).toEqual(["enhancement/feature", "test/present"]);
    expect(detail.checks.map((check) => check.status)).toEqual(["skipped", "passed", "skipped", "skipped"]);
    expect(detail.comments.filter((comment) => comment.kind === "comment")).toHaveLength(4);
    expect(detail.comments.filter((comment) => comment.kind === "review").map((comment) => [comment.author.login, comment.verdict])).toEqual([["famfo-cb", "approved"], ["Gusted", "approved"]]);
    expect(detail.commits).toHaveLength(1);
  });

  it("folds review comments on one line into a conversation and diffs through the API", async () => {
    const { invoke } = await harness();
    const threads = await invoke<PullRequestThread[]>("pr-comments", { url: URL_14486 });
    expect(threads).toEqual([expect.objectContaining({ path: "tests/integration/lfs_getobject_test.go", line: 287, side: "new", resolved: false })]);
    expect(threads[0]!.comments).toHaveLength(2);
    const files = await invoke<PullRequestFiles>("pr-files", { url: URL_14486 });
    expect(files.viewedOn).toBe("local");
    expect(files.files.map((file) => file.path)).toEqual(expect.arrayContaining(["tests/integration/lfs_getobject_test.go"]));
  });

  it("submits a review with its verdict and line comments on the head it read", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-review", { url: URL_14486, event: "request-changes", body: "Not yet.", comments: [{ id: "c1", path: "a.go", line: 3, side: "new", body: "Here." }] });
    const review = calls.find((call) => call.args.at(-1) === `${API}/pulls/14486/reviews` && call.args.includes("POST"))!;
    expect(JSON.parse(review.input!)).toEqual({
      event: "REQUEST_CHANGES", body: "Not yet.", commit_id: "1cbdbe71bcc602d20a7d254ead5e3ae4ecc12a4a",
      comments: [{ path: "a.go", body: "Here.", new_position: 3 }],
    });
    await expect(invoke("pr-comment", { url: URL_14486, threadId: "23383834", body: "Reply" })).rejects.toThrow(/Forgejo does not let Tau reply/u);
  });

  it("lists merged requests from the closed ones", async () => {
    const { invoke, calls } = await harness();
    const list = await invoke<PullRequestList>("pr-list", { state: "merged", limit: 10 });
    expect(calls[0]!.args.at(-1)).toBe(`${API}/pulls?state=closed&sort=recentupdate&page=1&limit=50`);
    expect(list).toMatchObject({ service: "forgejo", host: "codeberg.org", repo: "forgejo/forgejo", viewer: "Gusted", truncated: false });
    expect(list.entries.map((entry) => entry.ref.number)).toEqual([14456, 14445]);
  });

  it("reads tea's HTTP status: a 401 asks for a login, a 429 pauses the host", async () => {
    const denied = await harness({ fail: (url) => url.includes("/pulls/14486") ? 401 : undefined });
    await expect(denied.invoke("pr-view", { url: URL_14486 })).rejects.toThrow(/Gitea CLI \(tea\) is not signed in/u);
    const limited = await harness({ fail: (url) => url.includes("/pulls/14486") ? 429 : undefined });
    await expect(limited.invoke("pr-view", { url: URL_14486 })).rejects.toThrow(/rate limit/u);
    const before = limited.calls.length;
    await expect(limited.invoke("pr-view", { url: URL_14486, fresh: true })).rejects.toThrow(/Forgejo's rate limit for codeberg.org is reached; Tau asks again in 30 seconds/u);
    expect(limited.calls.length).toBe(before);
  });
});
