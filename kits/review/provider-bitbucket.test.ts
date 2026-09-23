import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type PullRequestDetail, type PullRequestFiles, type PullRequestList, type PullRequestThread, type ReviewRequestContext, type ReviewRequestStatus } from "./protocol.js";
import type { HttpFetch } from "./provider.js";
import type { CliRunOptions } from "./request-cli.js";
import { LINK_SEAMS } from "./test-seams.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const API = "https://api.bitbucket.org/2.0/repositories/atlassian/bitbucket-upload-file";
const URL_11 = "https://bitbucket.org/atlassian/bitbucket-upload-file/pull-requests/11";

interface Sent { url: string; method: string; headers: Record<string, string>; body?: unknown }

const stateRoots: string[] = [];
afterEach(async () => { await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function answer(url: string, method: string): Promise<{ status: number; body: string; headers?: Record<string, string> }> {
  if (method !== "GET") return { status: 201, body: url.endsWith("/pullrequests") ? JSON.stringify({ id: 30, links: { html: { href: "https://bitbucket.org/atlassian/bitbucket-upload-file/pull-requests/30" } } }) : "{}" };
  const path = url.replace(API, "");
  if (url.endsWith("/2.0/user")) return { status: 200, body: JSON.stringify({ display_name: "Raul Gomis", nickname: "Raul Gomis" }) };
  if (path.startsWith("/pullrequests?")) return { status: 200, body: await fixture("bitbucket-pulls.json") };
  if (path === "/pullrequests/11") return { status: 200, body: await fixture("bitbucket-pull.json") };
  if (path.startsWith("/pullrequests/11/comments")) return { status: 200, body: await fixture("bitbucket-comments.json") };
  if (path.startsWith("/pullrequests/11/commits")) return { status: 200, body: await fixture("bitbucket-commits.json") };
  if (path.startsWith("/pullrequests/") && path.includes("/statuses")) return { status: 200, body: await fixture("bitbucket-statuses.json") };
  if (path.startsWith("/pullrequests/11/diffstat")) return { status: 200, body: await fixture("bitbucket-diffstat.json") };
  if (path === "/pullrequests/11/diff") return { status: 200, body: await fixture("bitbucket-pull.diff") };
  return { status: 404, body: JSON.stringify({ type: "error", error: { message: "Not found" } }) };
}

/** Review Kit over a fake Bitbucket API and a fake `git credential fill`. */
async function harness(options: {
  credential?: Record<string, string>;
  context?: Partial<ReviewRequestContext>;
  fail?(url: string): { status: number; headers?: Record<string, string> } | undefined;
  rewrite?(url: string, body: string): string;
} = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), "tau-bitbucket-"));
  stateRoots.push(stateRoot);
  const sent: Sent[] = [];
  const asked: string[] = [];
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
      context.registerCommand("review-request-context", () => ({
        root: "/project", branch: "feature/add-upload", base: "master",
        remote: { name: "origin", url: "git@bitbucket.org:atlassian/bitbucket-upload-file.git" },
        ...options.context,
      }), callers);
      context.registerCommand("push", () => ({}), callers);
    },
  };
  // Git's helper answers by host; the stdin names the host asked for.
  const run = vi.fn(async (_command: string, args: string[], _cwd: string, runOptions?: CliRunOptions) => {
    expect(args).toEqual(["-c", "core.askPass=", "credential", "fill"]);
    expect(runOptions?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" });
    const host = /host=(.+)/u.exec(runOptions?.input ?? "")?.[1] ?? "";
    asked.push(host);
    const found = (options.credential ?? { "api.bitbucket.org": "username=octo@example.com\npassword=token-1" })[host];
    if (!found) throw new Error("fatal: could not read Username: terminal prompts disabled");
    return `protocol=https\nhost=${host}\n${found}\n`;
  });
  const fetch: HttpFetch = vi.fn(async (url: string, init) => {
    sent.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) as unknown } : {}) });
    const failed = options.fail?.(url);
    const reply = failed ? { status: failed.status, body: JSON.stringify({ error: { message: "nope" } }), headers: failed.headers } : await answer(url, init.method);
    if (options.rewrite) reply.body = options.rewrite(url, reply.body);
    return { status: reply.status, headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null }, text: async () => reply.body };
  });
  const registry = await activateHostKit(workspace, {
    ...LINK_SEAMS,
    findCommand: (name: string) => (name === "git" ? "/usr/bin/git" : undefined),
    noteSubprocess: () => undefined,
    stateDir: stateRoot,
    runtimeOwner: () => "tau",
  });
  await registry.activate(createReviewHostExtension({ run, fetch, env: {} }));
  const invoke = <T = unknown>(command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input) as Promise<T>;
  return { invoke, sent, asked };
}

describe("the Bitbucket provider over its API", () => {
  it("signs with the API credential Git's helper holds and finds the branch's request", async () => {
    const { invoke, sent, asked } = await harness({ context: { branch: "feature/PIPES-1654" } });
    const status = await invoke<ReviewRequestStatus>("pr-status");
    expect(status).toMatchObject({ service: "bitbucket", request: { provider: "bitbucket", number: 26, baseRef: "master", state: "merged" } });
    expect(status.problem).toBeUndefined();
    expect(asked).toEqual(["api.bitbucket.org"]);
    const lookup = new URL(sent[0]!.url);
    expect(lookup.searchParams.get("q")).toBe('source.branch.name = "feature/PIPES-1654"');
    expect(lookup.searchParams.getAll("state")).toEqual(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
    expect(sent[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("octo@example.com:token-1").toString("base64")}`);
  });

  it("falls back to bitbucket.org's credential, sends an access token as a bearer, and says when there is none", async () => {
    const token = await harness({ credential: { "bitbucket.org": "username=x-token-auth\npassword=repo-token" } });
    await token.invoke("pr-view", { url: URL_11 });
    expect(token.asked).toEqual(["api.bitbucket.org", "bitbucket.org"]);
    expect(token.sent[0]!.headers.Authorization).toBe("Bearer repo-token");
    const none = await harness({ credential: {} });
    expect((await none.invoke<ReviewRequestStatus>("pr-status")).problem).toMatch(/Git's credential helper for Bitbucket is not signed in/u);
    await expect(none.invoke("pr-view", { url: URL_11 })).rejects.toThrow(/holds no Bitbucket credential/u);
    expect(none.sent).toEqual([]);
  });

  it("reads a request with its reviewers, statuses, commits and line counts", async () => {
    const { invoke } = await harness();
    const detail = await invoke<PullRequestDetail>("pr-view", { url: URL_11 });
    expect(detail).toMatchObject({ state: "merged", baseRef: "master", headSha: "c6ee5d86f36e", changedFiles: 5, additions: 136, deletions: 26, viewer: "Raul Gomis" });
    expect(detail.reviewers).toEqual([{ login: "Raul Gomis", verdict: "approved" }, { login: "Halyna Berezovska", verdict: "approved" }]);
    expect(detail.checks).toEqual([expect.objectContaining({ status: "passed" })]);
    expect(detail.commits).toHaveLength(2);
    // Every comment on this request sits on a line; the timeline keeps the approvals.
    expect(detail.comments.every((comment) => comment.kind === "review")).toBe(true);
  });

  it("threads line comments with their replies and diffs through the API", async () => {
    const { invoke } = await harness();
    const threads = await invoke<PullRequestThread[]>("pr-comments", { url: URL_11 });
    expect(threads).toHaveLength(8);
    const replied = threads.find((thread) => thread.id === "170815737")!;
    expect(replied).toMatchObject({ path: ".changes/next-release/minor-20200812195730.json", line: 3, side: "new" });
    expect(replied.comments.map((comment) => comment.id)).toEqual(["170815737", "170815864"]);
    const files = await invoke<PullRequestFiles>("pr-files", { url: URL_11 });
    expect(files.files).toHaveLength(5);
    expect(files.viewedOn).toBe("local");
  });

  it("creates, merges and reviews with the API's own shapes", async () => {
    const { invoke, sent } = await harness({ context: { branch: "feature/new" } });
    const created = await invoke<{ url?: string }>("pr-create", { title: "Add it", body: "Why", draft: true });
    expect(created.url).toBe("https://bitbucket.org/atlassian/bitbucket-upload-file/pull-requests/30");
    expect(sent.find((call) => call.method === "POST")!.body).toEqual({ title: "Add it", description: "Why", source: { branch: { name: "feature/new" } }, destination: { branch: { name: "master" } }, draft: true });

    const open = await harness({ context: { branch: "feature/PIPES-1654" } });
    await expect(open.invoke("pr-merge", { method: "rebase" })).rejects.toThrow(/PR #26 is merged/u);
    await open.invoke("pr-review", { url: URL_11, event: "request-changes", body: "Not yet.", comments: [{ id: "c", path: "README.md", line: 4, side: "old", body: "Here." }] });
    const posts = open.sent.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.url.replace(API, ""))).toEqual(["/pullrequests/11/comments", "/pullrequests/11/comments", "/pullrequests/11/request-changes"]);
    expect(posts[0]!.body).toEqual({ content: { raw: "Here." }, inline: { path: "README.md", from: 4 } });
    await open.invoke("pr-comment", { url: URL_11, threadId: "170815737", body: "Done." });
    expect(open.sent.at(-1)!.body).toEqual({ content: { raw: "Done." }, parent: { id: 170815737 } });
    await expect(open.invoke("pr-resolve", { url: URL_11, threadId: "170815737" })).rejects.toThrow(/Bitbucket does not let Tau resolve/u);
  });

  it("merges an open request by merge commit or squash only", async () => {
    const reopened = (body: string) => body.replaceAll('"state": "MERGED"', '"state": "OPEN"');
    const { invoke, sent } = await harness({ context: { branch: "feature/PIPES-1654" }, rewrite: (url, body) => url.includes("/pullrequests?") ? reopened(body) : body });
    await expect(invoke("pr-merge", { method: "rebase" })).rejects.toThrow("Bitbucket merges by merge commit or squash only.");
    await invoke("pr-merge", { method: "squash" });
    expect(sent.find((call) => call.url.endsWith("/merge"))).toMatchObject({ url: `${API}/pullrequests/26/merge`, body: { merge_strategy: "squash" } });
  });

  it("lists by state with the reviewers' verdicts and pauses on a 429 until the reset", async () => {
    const { invoke, sent } = await harness();
    const list = await invoke<PullRequestList>("pr-list", { state: "closed", limit: 10, search: "pipe" });
    const asked = new URL(sent.find((call) => call.url.includes("/pullrequests?"))!.url);
    expect(asked.searchParams.getAll("state")).toEqual(["DECLINED", "SUPERSEDED"]);
    expect(asked.searchParams.get("q")).toBe('title ~ "pipe"');
    expect(list).toMatchObject({ service: "bitbucket", host: "bitbucket.org", repo: "atlassian/bitbucket-upload-file" });
    expect(list.entries.map((entry) => entry.ref.url)).toContain("https://bitbucket.org/atlassian/bitbucket-upload-file/pull-requests/27");

    const limited = await harness({ fail: (url) => url.includes("/pullrequests/11") ? { status: 429, headers: { "retry-after": "120" } } : undefined });
    await expect(limited.invoke("pr-view", { url: URL_11 })).rejects.toThrow(/rate limit/u);
    const before = limited.sent.length;
    await expect(limited.invoke("pr-view", { url: URL_11, fresh: true })).rejects.toThrow(/Bitbucket's rate limit for bitbucket.org is reached; Tau asks again in 2 minutes/u);
    expect(limited.sent.length).toBe(before);
  });
});
