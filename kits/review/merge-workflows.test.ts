import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MergeOutcome, PullRequestDetail, PullRequestStack, ReviewRequest } from "./protocol.js";
import type { CliCall } from "./pull-request-cli.js";
import type { CliOptions, HttpAnswer, ProviderTools } from "./provider.js";
import { azureAutoMerge } from "./provider-azure.js";
import { createAzureProvider } from "./provider-azure.js";
import { createBitbucketProvider } from "./provider-bitbucket.js";
import { createForgejoProvider } from "./provider-forgejo.js";
import { createGitHubProvider } from "./provider-github.js";
import { createGitLabProvider } from "./provider-gitlab.js";
import { parseGitHubStack, parseStackMemberships, stackMembershipQuery } from "./github-stacks.js";
import { parseRequestUrl } from "./pull-request-json.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

interface Recorded { kind: string; args: string[]; input?: string; options?: CliOptions }

/** The tools a provider stands on, answering each CLI call from `answer` and keeping them in order. */
function fakeTools(answer: (call: Recorded) => string | Promise<string>, http?: (url: string, init: { method?: string; body?: string }) => string) {
  const calls: Recorded[] = [];
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  let clock = 0;
  const tools: ProviderTools = {
    findCommand: (name) => `/bin/${name}`,
    log: () => undefined,
    cli: async (kind, call: CliCall, _action, options) => {
      const recorded = { kind, args: call.args, ...(call.input !== undefined ? { input: call.input } : {}), ...(options ? { options } : {}) };
      calls.push(recorded);
      const output = await answer(recorded);
      options?.inspect?.(output, "HTTP/2.0 200 OK\n");
      return output;
    },
    http: async (_kind, url, init): Promise<HttpAnswer> => {
      requests.push({ url, ...(init.method ? { method: init.method } : {}), ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      const text = http?.(url, init) ?? "{}";
      return { status: 200, headers: { get: () => null }, text: async () => text };
    },
    credential: async () => ({ username: "octo", password: "secret" }),
    cached: (_kind, _ref, _fresh, read) => read(),
    drop: () => undefined,
    forget: vi.fn(),
    workspace: async () => undefined,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
  };
  return { tools, calls, requests };
}

const OPEN: ReviewRequest = { provider: "github", number: 7, title: "Add it", url: "https://github.com/acme/tau/pull/7", baseRef: "main", headRef: "feat/output", state: "open" };
const IN_CHECKOUT = { host: "github.com", repo: "acme/tau", cwd: "/project" };
const BY_URL = { host: "github.com", repo: "acme/tau" };

/** `gh` for a merged request whose branch may go. */
function github(overrides: { state?: string; defaultBranch?: string; based?: number[] } = {}) {
  return (call: Recorded): string => {
    const joined = call.args.join(" ");
    if (joined.startsWith("pr view 7")) {
      return JSON.stringify({ state: overrides.state ?? "MERGED", headRefName: "feat/output", headRepository: { name: "tau" }, headRepositoryOwner: { login: "acme" }, isCrossRepository: false });
    }
    if (joined.endsWith("--jq .default_branch")) return `${overrides.defaultBranch ?? "main"}\n`;
    if (joined.startsWith("pr list")) return JSON.stringify((overrides.based ?? []).map((number) => ({ number })));
    return "";
  };
}

describe("deleting the branch on merge", () => {
  it("merges in the checkout, then deletes the head branch on GitHub", async () => {
    const { tools, calls } = fakeTools(github());
    const outcome = await createGitHubProvider(tools).merge(IN_CHECKOUT, OPEN, "squash", { deleteBranch: true });
    expect(outcome).toEqual({ branchDeleted: "feat/output" });
    expect(calls.map((call) => call.args)).toEqual([
      ["pr", "merge", "7", "--squash"],
      ["pr", "view", "7", "--repo", "github.com/acme/tau", "--json", "state,headRefName,headRepository,headRepositoryOwner,isCrossRepository"],
      ["api", "--hostname", "github.com", "repos/acme/tau", "--jq", ".default_branch"],
      ["pr", "list", "--repo", "github.com/acme/tau", "--base", "feat/output", "--state", "open", "--json", "number", "--limit", "5"],
      ["api", "--hostname", "github.com", "--method", "DELETE", "repos/acme/tau/git/refs/heads/feat/output"],
    ]);
    expect(calls[0]!.options).toEqual({ cwd: "/project" });
  });

  it("keeps a branch another request stands on, the default branch, and one not merged yet", async () => {
    const kept = async (overrides: Parameters<typeof github>[0]) => {
      const { tools, calls } = fakeTools(github(overrides));
      const outcome = await createGitHubProvider(tools).merge(BY_URL, OPEN, "merge", { deleteBranch: true }) as MergeOutcome;
      expect(calls.some((call) => call.args.includes("DELETE"))).toBe(false);
      return outcome.branchKept;
    };
    await expect(kept({ based: [9] })).resolves.toBe("PR #9 is based on feat/output.");
    await expect(kept({ defaultBranch: "feat/output" })).resolves.toBe("feat/output is the default branch of acme/tau.");
    await expect(kept({ state: "OPEN" })).resolves.toBe("feat/output stays until the merge has landed.");
  });

  it("names the repository when the request was opened by its URL, and deletes nothing unasked", async () => {
    const { tools, calls } = fakeTools(github());
    await expect(createGitHubProvider(tools).merge(BY_URL, OPEN, "rebase")).resolves.toBeUndefined();
    expect(calls.map((call) => call.args)).toEqual([["pr", "merge", "7", "--rebase", "--repo", "github.com/acme/tau"]]);
  });

  it("asks GitLab, Forgejo, Bitbucket and Azure DevOps to delete it as they merge", async () => {
    const gitlab = fakeTools(() => "");
    await expect(createGitLabProvider(gitlab.tools).merge({ host: "gitlab.com", repo: "acme/tau" }, { ...OPEN, provider: "gitlab" }, "squash", { deleteBranch: true })).resolves.toEqual({ branchDeleted: "feat/output" });
    expect(gitlab.calls[0]!.args).toEqual(["mr", "merge", "7", "--yes", "--squash", "--remove-source-branch", "--repo", "https://gitlab.com/acme/tau"]);

    const forgejo = fakeTools((call) => call.args[0] === "login" ? fixture("tea-logins.json") : "{}");
    await createForgejoProvider(forgejo.tools).merge({ host: "codeberg.org", repo: "acme/tau" }, { ...OPEN, provider: "forgejo" }, "rebase", { deleteBranch: true });
    const merged = forgejo.calls.find((call) => call.args.at(-1)?.endsWith("/pulls/7/merge"));
    expect(JSON.parse(merged!.input!)).toEqual({ Do: "rebase", delete_branch_after_merge: true });

    const bitbucket = fakeTools(() => "");
    await createBitbucketProvider(bitbucket.tools, {}).merge({ host: "bitbucket.org", repo: "acme/tau" }, { ...OPEN, provider: "bitbucket" }, "squash", { deleteBranch: true });
    expect(bitbucket.requests.at(-1)).toMatchObject({ method: "POST", body: { merge_strategy: "squash", close_source_branch: true } });

    const azure = fakeTools(() => "{}");
    await createAzureProvider(azure.tools).merge({ host: "dev.azure.com", repo: "acme/tau/tau" }, { ...OPEN, provider: "azure-devops" }, "merge", { deleteBranch: true });
    expect(azure.calls[0]!.args.slice(0, 11)).toEqual(["repos", "pr", "update", "--id", "7", "--status", "completed", "--squash", "false", "--delete-source-branch", "true"]);
  });
});

describe("auto-merge", () => {
  it("arms and disarms it with gh, keeping the method", async () => {
    const { tools, calls } = fakeTools(() => "");
    const provider = createGitHubProvider(tools);
    await provider.autoMerge!(IN_CHECKOUT, OPEN, true, "squash");
    await provider.autoMerge!(BY_URL, OPEN, false, undefined);
    expect(calls.map((call) => call.args)).toEqual([
      ["pr", "merge", "7", "--auto", "--squash"],
      ["pr", "merge", "7", "--disable-auto", "--repo", "github.com/acme/tau"],
    ]);
  });

  it("arms it with glab and takes it back through GitLab's API", async () => {
    const { tools, calls } = fakeTools(() => "");
    const provider = createGitLabProvider(tools);
    const request = { ...OPEN, provider: "gitlab" as const };
    await provider.autoMerge!({ host: "gitlab.com", repo: "acme/tools/tau" }, request, true, "rebase", { deleteBranch: true });
    await provider.autoMerge!({ host: "gitlab.com", repo: "acme/tools/tau" }, request, false, undefined);
    expect(calls.map((call) => call.args)).toEqual([
      ["mr", "merge", "7", "--yes", "--auto-merge=true", "--rebase", "--remove-source-branch", "--repo", "https://gitlab.com/acme/tools/tau"],
      ["api", "--hostname", "gitlab.com", "--method", "POST", "projects/acme%2Ftools%2Ftau/merge_requests/7/cancel_merge_when_pipeline_succeeds"],
    ]);
    await expect(provider.autoMerge!({ host: "", repo: "", cwd: "/p" }, request, false, undefined)).rejects.toThrow("could not tell which GitLab project");
  });

  it("is Azure DevOps' auto-complete, read back from who set it", async () => {
    const { tools, calls } = fakeTools(() => "{}");
    const provider = createAzureProvider(tools);
    await provider.autoMerge!({ host: "dev.azure.com", repo: "acme/tau/tau" }, { ...OPEN, provider: "azure-devops" }, true, "squash", { deleteBranch: true });
    await provider.autoMerge!({ host: "dev.azure.com", repo: "acme/tau/tau" }, { ...OPEN, provider: "azure-devops" }, false, undefined);
    expect(calls.map((call) => call.args.slice(5, 11))).toEqual([
      ["--auto-complete", "true", "--squash", "true", "--delete-source-branch", "true"],
      ["--auto-complete", "false", "--organization", "https://dev.azure.com/acme", "--output", "json"],
    ]);
    expect(azureAutoMerge({ autoCompleteSetBy: { id: "u1" }, completionOptions: { squashMerge: true } })).toEqual({ method: "squash" });
    expect(azureAutoMerge({ completionOptions: { squashMerge: true } })).toBeUndefined();
  });
});

describe("reverting a merged request", () => {
  it("asks GitHub for a revert request by the merged one's id", async () => {
    const { tools, calls } = fakeTools(() => JSON.stringify({ data: { revertPullRequest: { revertPullRequest: { number: 8, url: "https://github.com/acme/tau/pull/8" } } } }));
    const ref = parseRequestUrl(OPEN.url)!;
    const known = { ref, nodeId: "PR_7" } as PullRequestDetail;
    await expect(createGitHubProvider(tools).revert!(ref, known)).resolves.toBe("https://github.com/acme/tau/pull/8");
    expect(calls[0]!.args).toEqual(["api", "--hostname", "github.com", "graphql", "--input", "-"]);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ query: expect.stringContaining("revertPullRequest(input: { pullRequestId: $id })"), variables: { id: "PR_7" } });
    await expect(createGitHubProvider(tools).revert!(ref, { ref } as PullRequestDetail)).rejects.toThrow("did not name PR #7's id");
  });
});

describe("GitHub stacks", () => {
  const ref = parseRequestUrl("https://github.com/react/react/pull/37589")!;

  it("reads a recorded stack and the positions of listed requests", () => {
    const stack = parseGitHubStack(fixture("gh-stack.json"), "github.com", "react/react")!;
    expect(stack).toMatchObject({ number: 37595, base: "main" });
    expect(stack.layers.slice(0, 2)).toEqual([
      { number: 37588, url: "https://github.com/react/react/pull/37588", headRef: "ledgers/1-flag", headSha: "6f5c73e296f33c497cf84d451048110dd757ddf6", state: "open", draft: false },
      { number: 37589, url: "https://github.com/react/react/pull/37589", headRef: "ledgers/2-dedupe-map", headSha: "2ba5ce3869187f0b3520ccd1d70e7a3019e0c65b", state: "open", draft: false },
    ]);
    expect(stack.layers).toHaveLength(8);
    expect(parseGitHubStack("[]", "github.com", "react/react")).toBeUndefined();
    expect(parseStackMemberships(fixture("gh-stack-memberships.json"))).toEqual(new Map([
      [37588, { number: 37595, size: 8, position: 1 }],
      [37589, { number: 37595, size: 8, position: 2 }],
    ]));
    expect(stackMembershipQuery([3, 4])).toContain("r3: pullRequest(number: 3) { stack { number size } stackEntry { position } } r4:");
  });

  /** A stack of two open layers as the user saw it, and `gh` answering around it. */
  function stackHost(options: { merge?: string[]; permission?: string; behind?: number[]; moved?: boolean } = {}) {
    const seen: PullRequestStack = {
      number: 50, base: "main",
      layers: [
        { number: 48, url: "https://github.com/react/react/pull/48", headRef: "one", headSha: "a1", state: "open" },
        { number: 49, url: "https://github.com/react/react/pull/49", headRef: "two", headSha: "b1", state: "open" },
      ],
    };
    const listing = JSON.stringify([{ number: 50, base: { ref: "main" }, pull_requests: seen.layers.map((layer) => ({ number: layer.number, state: "open", draft: false, merged_at: null, head: { ref: layer.headRef, sha: options.moved && layer.number === 49 ? "b2" : layer.headSha } })) }]);
    const merges = [...(options.merge ?? ['{"status":"merged","details":{}}'])];
    let rebased = 0;
    const heads: Record<string, string> = { PR_48: "a1", PR_49: "b1" };
    const { tools, calls } = fakeTools((call) => {
      const path = call.args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.includes("/stacks?")) return listing;
      if (path.includes("merge-async")) return merges.shift() ?? '{"status":"merged","details":{}}';
      const body = call.input ? JSON.parse(call.input) as { query: string; variables: Record<string, unknown> } : undefined;
      if (body?.query.includes("{ title }")) return JSON.stringify({ data: { repository: { r48: { title: "One" }, r49: { title: "Two" } } } });
      if (body?.query.includes("viewerPermission")) return JSON.stringify({ data: { repository: { r48: { headRepository: { viewerPermission: options.permission ?? "WRITE" }, maintainerCanModify: false }, r49: { headRepository: { viewerPermission: "WRITE" }, maintainerCanModify: false } } } });
      if (body?.query.includes("compare(headRef")) {
        const number = body.variables.number as number;
        const done = (body.variables.done as string[]).map((id) => ({ headRefOid: heads[id] }));
        const behindBy = options.behind?.[number === 48 ? 0 : 1] ?? 1;
        return JSON.stringify({ data: { done, repository: { pullRequest: { id: `PR_${number}`, headRefOid: body.variables.sha, baseRef: { compare: { behindBy } } } } } });
      }
      if (body?.query.includes("updatePullRequestBranch")) {
        rebased += 1;
        heads[body.variables.id as string] = "rebased";
        return JSON.stringify({ data: { updatePullRequestBranch: { pullRequest: { headRefOid: "rebased" } } } });
      }
      return "{}";
    });
    return { seen, tools, calls, rebased: () => rebased };
  }

  it("merges a layer with the ones below it, following GitHub until it is done", async () => {
    const { seen, tools, calls } = stackHost({ merge: ['{"status":"pending","details":{"uuid":"m-1"}}', '{"status":"pending","details":{"uuid":"m-1"}}', '{"status":"merged","details":{}}'] });
    const stacks = createGitHubProvider(tools);
    const top = { ...ref, repo: "react/react", number: 49, url: "https://github.com/react/react/pull/49" };
    await stacks.stackAction!(top, { action: "merge", seen, method: "squash" });
    const merges = calls.filter((call) => call.args.some((arg) => arg.includes("merge-async")));
    expect(merges[0]!.args).toEqual(["api", "--hostname", "github.com", "--method", "PUT", "repos/react/react/pulls/49/merge-async", "-f", "merge_method=squash", "-f", "merge_action=default", "-f", "sha=b1"]);
    expect(merges.slice(1).map((call) => call.args.at(-1))).toEqual(["repos/react/react/pulls/49/merge-async/m-1", "repos/react/react/pulls/49/merge-async/m-1"]);
    expect(tools.forget).toHaveBeenCalledTimes(2);
  });

  it("refuses a stack that moved since the user looked, and says what GitHub refused", async () => {
    const moved = stackHost({ moved: true });
    const top = { ...ref, number: 49, url: "https://github.com/react/react/pull/49" };
    await expect(createGitHubProvider(moved.tools).stackAction!(top, { action: "merge", seen: moved.seen })).rejects.toThrow("The stack changed since you looked at it.");
    expect(moved.calls.some((call) => call.args.some((arg) => arg.includes("merge-async")))).toBe(false);
    const refused = stackHost({ merge: ['{"status":"failed","details":{"message":"Required status check is failing"}}'] });
    await expect(createGitHubProvider(refused.tools).stackAction!(top, { action: "merge", seen: refused.seen })).rejects.toThrow("GitHub refused the stack merge: Required status check is failing.");
  });

  it("rebases the layers bottom to top, only those behind, and stops without write access", async () => {
    const rebase = stackHost({ behind: [0, 2] });
    const bottom = { ...ref, number: 48, url: "https://github.com/react/react/pull/48" };
    await createGitHubProvider(rebase.tools).stackAction!(bottom, { action: "rebase", seen: rebase.seen });
    expect(rebase.rebased()).toBe(1);
    const mutation = rebase.calls.find((call) => call.input?.includes("updatePullRequestBranch"));
    expect(JSON.parse(mutation!.input!).variables).toEqual({ id: "PR_49", sha: "b1" });

    const readOnly = stackHost({ permission: "READ" });
    await expect(createGitHubProvider(readOnly.tools).stackAction!(bottom, { action: "rebase", seen: readOnly.seen })).rejects.toThrow("You cannot update the branch of PR #48.");
    expect(readOnly.rebased()).toBe(0);
  });
});
