import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { parseGitHubBranchRequest, parseGitLabBranchRequest, summarizeGitHubChecks } from "./branch-request-json.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import { LINK_SEAMS } from "./test-seams.js";

const ghOutput = JSON.stringify({ number: 42, title: "Add review bases", url: "https://github.com/acme/tau/pull/42", baseRefName: "main", headRefName: "feature/bases" });
const glabOutput = JSON.stringify({ iid: 7, title: "Merge me", web_url: "https://gitlab.com/acme/tau/-/merge_requests/7", target_branch: "develop", source_branch: "topic" });

describe("a branch's request as the CLIs print it", () => {
  it("reads gh and glab", () => {
    expect(parseGitHubBranchRequest(ghOutput)).toEqual({ provider: "github", number: 42, title: "Add review bases", url: "https://github.com/acme/tau/pull/42", baseRef: "main", headRef: "feature/bases" });
    expect(parseGitLabBranchRequest(glabOutput)).toEqual({ provider: "gitlab", number: 7, title: "Merge me", url: "https://gitlab.com/acme/tau/-/merge_requests/7", baseRef: "develop", headRef: "topic" });
    expect(parseGitHubBranchRequest(JSON.stringify({ number: 1 }))).toBeUndefined();
  });

  it("reads state, draft, checks, body and an armed merge", () => {
    const gh = JSON.stringify({
      number: 9, title: "Draft it", url: "https://github.com/acme/tau/pull/9", baseRefName: "main", headRefName: "topic",
      state: "OPEN", isDraft: true, body: "Why", autoMergeRequest: { mergeMethod: "SQUASH" },
      statusCheckRollup: [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "StatusContext", state: "SUCCESS" },
      ],
    });
    expect(parseGitHubBranchRequest(gh)).toMatchObject({ state: "open", draft: true, body: "Why", checks: { passed: 2, failed: 1, pending: 1, total: 4 }, autoMerge: { method: "squash" } });
    expect(parseGitHubBranchRequest(JSON.stringify({ ...JSON.parse(gh), autoMergeRequest: null }))).not.toHaveProperty("autoMerge");
    expect(summarizeGitHubChecks([])).toBeUndefined();
    const glab = JSON.stringify({ iid: 3, title: "MR", web_url: "https://gitlab.com/a/b/-/merge_requests/3", target_branch: "main", state: "merged", draft: false, head_pipeline: { status: "running" }, merge_when_pipeline_succeeds: true });
    expect(parseGitLabBranchRequest(glab)).toMatchObject({ state: "merged", draft: false, checks: { pending: 1, total: 1 }, autoMerge: {} });
  });
});

describe("Workspace Kit asks Review Kit for a branch's request", () => {
  async function harness(tools: Record<string, string>, answer: (command: string, args: string[]) => string) {
    let ask: ((input: unknown) => Promise<unknown>) | undefined;
    const workspace = {
      id: "tau.workspace",
      name: "Workspace Kit",
      permissions: [] as string[],
      activate(context: HostExtensionContext) {
        ask = (input) => context.invokeHostExtension(REVIEW_HOST_EXTENSION_ID, "branch-request", input);
      },
    };
    const run = vi.fn(async (command: string, args: string[]) => answer(command, args));
    const registry = await activateHostKit(workspace, { ...LINK_SEAMS, findCommand: (name: string) => tools[name], noteSubprocess: () => undefined, runtimeOwner: () => "tau" });
    await registry.activate(createReviewHostExtension({ run }));
    return { ask: ask!, run };
  }

  it("answers through the provider the remote belongs to, once per half minute unless fresh", async () => {
    const { ask, run } = await harness({ gh: "/bin/gh" }, () => ghOutput);
    const input = { root: "/worktree", branch: "feature/bases", remote: "git@github.com:acme/tau.git" };
    await expect(ask(input)).resolves.toMatchObject({ provider: "github", number: 42, baseRef: "main" });
    await ask(input);
    expect(run.mock.calls.filter(([, args]) => args[0] === "pr")).toHaveLength(1);
    expect(run.mock.calls[0]![1]).toEqual(["pr", "view", "--json", expect.stringContaining("autoMergeRequest")]);
    await ask({ ...input, fresh: true });
    expect(run.mock.calls.filter(([, args]) => args[0] === "pr")).toHaveLength(2);
  });

  it("answers undefined without a request, a CLI or a remote it can read", async () => {
    const none = await harness({ gh: "/bin/gh" }, () => { throw new Error("no pull requests found for branch \"topic\""); });
    await expect(none.ask({ root: "/w", branch: "topic", remote: "git@github.com:acme/tau.git" })).resolves.toBeUndefined();
    const noCli = await harness({}, () => ghOutput);
    await expect(noCli.ask({ root: "/w", branch: "topic", remote: "git@github.com:acme/tau.git" })).resolves.toBeUndefined();
    expect(noCli.run).not.toHaveBeenCalled();
    await expect(noCli.ask({ root: "/w", branch: "topic" })).resolves.toBeUndefined();
  });

  it("reaches the host the remote names", async () => {
    const { ask, run } = await harness({ glab: "/bin/glab", gh: "/bin/gh" }, () => glabOutput);
    await expect(ask({ root: "/w", branch: "topic", remote: "https://gitlab.example.com/acme/tau.git" })).resolves.toMatchObject({ provider: "gitlab", number: 7 });
    expect(run.mock.calls[0]).toEqual(["/bin/glab", ["mr", "view", "-F", "json"], "/w", {}]);
  });
});
