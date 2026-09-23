import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type PullRequestActionResult, type PullRequestList, type PullRequestStack, type ReviewRequestStatus, type ThreadPullRequestLink } from "./protocol.js";
import type { CliRunOptions } from "./request-cli.js";
import { LINK_SEAMS } from "./test-seams.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const URL_7 = "https://github.com/acme/tau/pull/7";

interface Call { args: string[]; input?: string }

let stateRoot: string | undefined;
afterEach(async () => { if (stateRoot) await rm(stateRoot, { recursive: true, force: true }); stateRoot = undefined; });

/** Review Kit over a fake `gh`, with a checkout on `feat/output` whose request is #7 in `state`. */
async function harness(options: { remote?: string; state?: string; answer?(call: Call): string | undefined } = {}) {
  stateRoot = await mkdtemp(join(tmpdir(), "tau-pr-actions-"));
  const calls: Call[] = [];
  let state = options.state ?? "OPEN";
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
      context.registerCommand("review-request-context", () => ({ root: "/project", branch: "feat/output", base: "main", upstream: "origin/feat/output", ahead: 0, remote: { name: "origin", url: options.remote ?? "git@github.com:acme/tau.git" } }), callers);
    },
  };
  const run = vi.fn(async (_command: string, args: string[], _cwd: string, runOptions?: CliRunOptions) => {
    if (args[0] === "api" && args.at(-1) === "user") return JSON.stringify({ login: "octo", username: "octo" });
    const call: Call = { args, ...(runOptions?.input !== undefined ? { input: runOptions.input } : {}) };
    calls.push(call);
    const custom = options.answer?.(call);
    if (custom !== undefined) return custom;
    const joined = args.join(" ");
    if (joined.startsWith("pr merge") && !args.includes("--auto") && !args.includes("--disable-auto")) state = "MERGED";
    if (joined.startsWith("pr view 7 --repo")) return JSON.stringify({ state, headRefName: "feat/output", headRepository: { name: "tau" }, headRepositoryOwner: { login: "acme" }, isCrossRepository: false });
    if (joined.startsWith("pr view --json")) return JSON.stringify({ number: 7, title: "Add it", url: URL_7, baseRefName: "main", headRefName: "feat/output", state, isDraft: false });
    if (joined.startsWith("pr view")) return JSON.stringify({ ...JSON.parse(await fixture("gh-pr-view-discussed.json")) as object, state });
    if (joined.startsWith("pr list --repo github.com/acme/tau --state")) return fixture("gh-pr-list.json");
    if (args.includes("graphql") && runOptions?.input?.includes("revertPullRequest")) return JSON.stringify({ data: { revertPullRequest: { revertPullRequest: { number: 8, url: "https://github.com/acme/tau/pull/8" } } } });
    if (args.includes("graphql") && runOptions?.input?.includes("stackEntry")) return JSON.stringify({ data: { repository: { r14485: { stack: { number: 20, size: 2 }, stackEntry: { position: 2 } } } } });
    if (args.some((arg) => arg.includes("/stacks?"))) return fixture("gh-stack.json");
    return "{}";
  });
  const registry = await activateHostKit(workspace, {
    ...LINK_SEAMS,
    findCommand: (name: string) => ({ gh: "/bin/gh", glab: "/bin/glab", git: "/usr/bin/git" } as Record<string, string>)[name],
    noteSubprocess: () => undefined,
    runtimeOwner: () => "tau",
    stateDir: stateRoot,
  });
  await registry.activate(createReviewHostExtension({ run, wait: async () => undefined, fetch: async () => { throw new Error("no network in this test"); }, env: {} }));
  const invoke = <T = unknown>(command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input) as Promise<T>;
  return { invoke, calls };
}

describe("the Changes section's merge", () => {
  it("merges and deletes the branch when asked, and says what became of it", async () => {
    const { invoke, calls } = await harness({ answer: ({ args }) => args.join(" ").endsWith("--jq .default_branch") ? "main" : args[0] === "pr" && args[1] === "list" ? "[]" : undefined });
    const result = await invoke<ReviewRequestStatus & { merge?: { branchDeleted?: string } }>("pr-merge", { method: "squash", deleteBranch: true });
    expect(result.merge).toEqual({ branchDeleted: "feat/output" });
    expect(calls.map((call) => call.args)).toContainEqual(["api", "--hostname", "github.com", "--method", "DELETE", "repos/acme/tau/git/refs/heads/feat/output"]);
  });

  it("arms auto-merge with the method and refuses it where the host cannot", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-auto-merge", { enable: true, method: "rebase" });
    await invoke("pr-auto-merge", { enable: false });
    expect(calls.map((call) => call.args).filter((args) => args[1] === "merge")).toEqual([["pr", "merge", "7", "--auto", "--rebase"], ["pr", "merge", "7", "--disable-auto"]]);
  });
});

describe("steps on a request opened by its URL", () => {
  it("merges by the repository's name, with the branch", async () => {
    const { invoke, calls } = await harness({ answer: ({ args }) => args.join(" ").endsWith("--jq .default_branch") ? "main" : args[0] === "pr" && args[1] === "list" ? "[]" : undefined });
    const result = await invoke<PullRequestActionResult>("pr-action", { url: URL_7, action: "merge", method: "merge", deleteBranch: true });
    expect(calls.map((call) => call.args)).toContainEqual(["pr", "merge", "7", "--merge", "--repo", "github.com/acme/tau"]);
    expect(result.merge).toEqual({ branchDeleted: "feat/output" });
    expect(result.detail.state).toBe("merged");
    await expect(invoke("pr-action", { url: URL_7, action: "merge", method: "merge" })).rejects.toThrow("PR #7 is merged.");
  });

  it("reverts a merged request and links the revert to the thread it came from", async () => {
    const { invoke } = await harness({ state: "MERGED" });
    const result = await invoke<PullRequestActionResult>("pr-action", { url: URL_7, action: "revert", threadId: "thread-1" });
    expect(result.created).toBe("https://github.com/acme/tau/pull/8");
    await vi.waitFor(async () => {
      const links = await invoke<ThreadPullRequestLink[]>("thread-links", { threadId: "thread-1" });
      expect(links).toEqual([expect.objectContaining({ url: "https://github.com/acme/tau/pull/8", source: "created" })]);
    });
    await expect(invoke("pr-action", { url: "https://gitlab.com/acme/tau/-/merge_requests/3", action: "revert" })).rejects.toThrow("GitLab does not let Tau revert a request");
  });

  it("refuses auto-merge where the provider has none", async () => {
    const { invoke } = await harness();
    await expect(invoke("pr-action", { url: "https://bitbucket.org/acme/tau/pull-requests/3", action: "auto-merge" })).rejects.toThrow("Bitbucket does not let Tau merge automatically");
    await expect(invoke("pr-action", { url: URL_7, action: "unknown" })).rejects.toThrow("Choose merge, auto-merge or revert.");
  });
});

describe("stacks through the kit's commands", () => {
  it("reads a request's stack, and lists open rows with their layer", async () => {
    const { invoke } = await harness();
    const stack = await invoke<PullRequestStack | null>("pr-stack", { url: "https://github.com/react/react/pull/37589" });
    expect(stack).toMatchObject({ number: 37595, layers: expect.arrayContaining([expect.objectContaining({ number: 37589, headRef: "ledgers/2-dedupe-map" })]) });
    await expect(invoke("pr-stack", { url: "https://gitlab.com/acme/tau/-/merge_requests/3" })).resolves.toBeNull();
    const list = await invoke<PullRequestList>("pr-list", { state: "open", limit: 10 });
    expect(list.entries.find((entry) => entry.ref.number === 14485)?.stack).toEqual({ number: 20, size: 2, position: 2 });
    expect(list.entries.find((entry) => entry.ref.number === 14475)?.stack).toBeUndefined();
  });

  it("refuses a stack step without the stack the user saw", async () => {
    const { invoke } = await harness();
    await expect(invoke("pr-stack-action", { url: URL_7, action: "merge" })).rejects.toThrow("Refresh the stack before acting on it.");
    await expect(invoke("pr-stack-action", { url: URL_7, action: "split" })).rejects.toThrow("Choose to merge or to rebase the stack.");
  });
});
