import { describe, expect, it, vi } from "vitest";
import { createReviewRequestDetector, parseGitHubPullRequest, parseGitLabMergeRequest, providerOrder, summarizeGitHubChecks } from "./review-request.js";

const ghOutput = JSON.stringify({ number: 42, title: "Add review bases", url: "https://github.com/acme/tau/pull/42", baseRefName: "main", headRefName: "feature/bases" });
const glabOutput = JSON.stringify({ iid: 7, title: "Merge me", web_url: "https://gitlab.com/acme/tau/-/merge_requests/7", target_branch: "develop", source_branch: "topic" });

describe("review request detection", () => {
  it("parses gh and glab output and asks the matching service first", () => {
    expect(parseGitHubPullRequest(ghOutput)).toEqual({ provider: "github", number: 42, title: "Add review bases", url: "https://github.com/acme/tau/pull/42", baseRef: "main", headRef: "feature/bases" });
    expect(parseGitLabMergeRequest(glabOutput)).toEqual({ provider: "gitlab", number: 7, title: "Merge me", url: "https://gitlab.com/acme/tau/-/merge_requests/7", baseRef: "develop", headRef: "topic" });
    expect(parseGitHubPullRequest(JSON.stringify({ number: 1 }))).toBeUndefined();
    expect(providerOrder("git@gitlab.example.com:acme/tau.git")).toEqual(["gitlab", "github"]);
    expect(providerOrder("https://github.com/acme/tau.git")).toEqual(["github", "gitlab"]);
    expect(providerOrder(undefined)).toEqual(["github", "gitlab"]);
  });

  it("finds the request through the installed tool and caches it per branch", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "branch") return "feature/bases\n";
      if (command === "git") return "https://github.com/acme/tau.git\n";
      if (command === "/bin/gh") return ghOutput;
      throw new Error(`unexpected ${command}`);
    });
    let clock = 1_000;
    const detector = createReviewRequestDetector({ findCommand: (name) => (name === "gh" ? "/bin/gh" : name === "git" ? "git" : undefined), run, cacheMs: 100, now: () => clock });
    expect(await detector.detect("/repo")).toMatchObject({ provider: "github", number: 42, baseRef: "main" });
    expect(await detector.detect("/repo")).toMatchObject({ number: 42 });
    expect(run.mock.calls.filter(([command]) => command === "/bin/gh")).toHaveLength(1);
    clock += 200;
    await detector.detect("/repo");
    expect(run.mock.calls.filter(([command]) => command === "/bin/gh")).toHaveLength(2);
  });

  it("answers undefined without a tool, without a branch, or when the tool fails, and falls through to the other service", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "branch") return "topic\n";
      if (command === "git") return "git@gitlab.example.com:acme/tau.git\n";
      if (command === "/bin/gh") throw new Error("no pull requests found");
      if (command === "/bin/glab") return glabOutput;
      throw new Error(`unexpected ${command}`);
    });
    const tools = { gh: "/bin/gh", glab: "/bin/glab", git: "git" } as Record<string, string>;
    const both = createReviewRequestDetector({ findCommand: (name) => tools[name], run });
    expect(await both.detect("/repo")).toMatchObject({ provider: "gitlab", number: 7 });
    // GitLab first because of the remote; gh is never asked when glab answers.
    expect(run.mock.calls.some(([command]) => command === "/bin/gh")).toBe(false);

    const onlyGh = createReviewRequestDetector({ findCommand: (name) => (name === "glab" ? undefined : tools[name]), run });
    expect(await onlyGh.detect("/repo")).toBeUndefined();

    const detached = createReviewRequestDetector({ findCommand: (name) => tools[name], run: async (command, args) => (command === "git" && args[0] === "branch" ? "" : glabOutput) });
    expect(await detached.detect("/repo")).toBeUndefined();

    const nothing = createReviewRequestDetector({ findCommand: () => undefined, run });
    expect(await nothing.detect("/repo")).toBeUndefined();
  });

  it("reads state, draft, checks and body when the tool reports them", () => {
    const gh = JSON.stringify({
      number: 9, title: "Draft it", url: "https://github.com/acme/tau/pull/9", baseRefName: "main", headRefName: "topic",
      state: "OPEN", isDraft: true, body: "Why",
      statusCheckRollup: [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "StatusContext", state: "SUCCESS" },
      ],
    });
    expect(parseGitHubPullRequest(gh)).toMatchObject({ state: "open", draft: true, body: "Why", checks: { passed: 2, failed: 1, pending: 1, total: 4 } });
    expect(summarizeGitHubChecks([])).toBeUndefined();
    const glab = JSON.stringify({ iid: 3, title: "MR", web_url: "https://gitlab.com/a/b/-/merge_requests/3", target_branch: "main", state: "merged", draft: false, head_pipeline: { status: "running" } });
    expect(parseGitLabMergeRequest(glab)).toMatchObject({ state: "merged", draft: false, checks: { pending: 1, total: 1 } });
  });

  it("asks again when the caller wants a fresh answer", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "branch") return "feature/bases\n";
      if (command === "git") return "https://github.com/acme/tau.git\n";
      return ghOutput;
    });
    const detector = createReviewRequestDetector({ findCommand: (name) => (name === "gh" ? "/bin/gh" : name === "git" ? "git" : undefined), run });
    await detector.detect("/repo");
    await detector.detect("/repo", { fresh: true });
    expect(run.mock.calls.filter(([command]) => command === "/bin/gh")).toHaveLength(2);
  });
});
