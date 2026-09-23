import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext, UiReviewRequest } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type ReviewRequestContext, type ReviewRequestStatus } from "./protocol.js";
import { explainCliFailure, serviceFor } from "./request-cli.js";
import { fallbackDraft, parseDraft } from "./requests-host.js";
import { LINK_SEAMS } from "./test-seams.js";

const CONTEXT: ReviewRequestContext = {
  root: "/project",
  branch: "feature/pr",
  remote: { name: "origin", url: "git@github.com:acme/tau.git" },
  upstream: "origin/feature/pr",
  ahead: 0,
  base: "main",
};

const OPEN: UiReviewRequest = { provider: "github", number: 7, title: "Add it", url: "https://github.com/acme/tau/pull/7", baseRef: "main", state: "open", draft: true };

interface Fixture {
  context?: Partial<ReviewRequestContext>;
  request?: UiReviewRequest;
  tools?: Record<string, string>;
  cli?(args: string[]): string | Promise<string>;
  complete?(): Promise<string>;
}

/** Workspace Kit's commands as Review reaches them, and `gh` as a function of its arguments. */
async function harness(fixture: Fixture = {}) {
  let request = fixture.request;
  const pushes = vi.fn();
  const calls: string[][] = [];
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
      context.registerCommand("review-request-context", (input) => ({
        ...CONTEXT,
        ...fixture.context,
        ...((input as { detail?: boolean } | undefined)?.detail ? { commits: [{ subject: "feat: add it", body: "" }], diffStat: " a.ts | 2 +-" } : {}),
      }), callers);
      context.registerCommand("review-request", () => request, callers);
      context.registerCommand("push", () => { pushes(); return { detail: "Pushed" }; }, callers);
    },
  };
  const tools = fixture.tools ?? { gh: "/bin/gh", git: "/usr/bin/git" };
  const run = vi.fn(async (_command: string, args: string[]) => {
    calls.push(args);
    const answer = await (fixture.cli?.(args) ?? "");
    if (args[0] === "pr" && args[1] === "create") request = { ...OPEN, draft: args.includes("--draft") };
    if (args[0] === "pr" && args[1] === "merge" && request) request = { ...request, state: "merged" };
    return answer;
  });
  const complete = vi.fn(fixture.complete ?? (async () => "Add the feature\n\n## Summary\nIt works."));
  const registry = await activateHostKit(workspace, {
    ...LINK_SEAMS,
    findCommand: (name: string) => tools[name],
    noteSubprocess: () => undefined,
    runtimeOwner: () => "tau",
    complete,
  });
  await registry.activate(createReviewHostExtension({ run }));
  const invoke = (command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input);
  return { registry, invoke, calls, pushes, complete };
}

describe("Review Kit request lifecycle", () => {
  it("reports the branch's request with its status and nothing missing", async () => {
    const { invoke } = await harness({ request: OPEN });
    await expect(invoke("pr-status")).resolves.toMatchObject({ branch: "feature/pr", base: "main", service: "github", request: { number: 7, draft: true } });
    const status = await invoke("pr-status") as ReviewRequestStatus;
    expect(status.problem).toBeUndefined();
  });

  it("says what is missing: branch, remote, tool, login", async () => {
    expect((await (await harness({ context: { branch: undefined } })).invoke("pr-status") as ReviewRequestStatus).problem).toMatch(/Check out a branch/u);
    expect((await (await harness({ context: { remote: undefined } })).invoke("pr-status") as ReviewRequestStatus).problem).toMatch(/no remote/u);
    expect((await (await harness({ tools: {} })).invoke("pr-status") as ReviewRequestStatus).problem).toMatch(/GitHub CLI \(gh\) is not installed/u);
    const loggedOut = await harness({ cli: (args) => { if (args[0] === "auth") throw new Error("You are not logged into any GitHub hosts. To log in, run: gh auth login"); return ""; } });
    expect((await loggedOut.invoke("pr-status") as ReviewRequestStatus).problem).toMatch(/not signed in. Run `gh auth login`/u);
    await expect(loggedOut.invoke("pr-create", { title: "Add it" })).rejects.toThrow("not signed in");
    expect(loggedOut.registry.isActive(REVIEW_HOST_EXTENSION_ID)).toBe(true);
  });

  it("picks glab for a GitLab remote and names it when it is missing", async () => {
    const { invoke } = await harness({ context: { remote: { name: "origin", url: "https://gitlab.example.com/acme/tau.git" } } });
    const status = await invoke("pr-status") as ReviewRequestStatus;
    expect(status.service).toBe("gitlab");
    expect(status.problem).toMatch(/GitLab CLI \(glab\)/u);
    expect(serviceFor("/tmp/remote.git", (name) => (name === "glab" ? "/bin/glab" : undefined))).toBe("gitlab");
  });

  it("drafts a title and body with the model, and from the commits without one", async () => {
    const { invoke } = await harness();
    await expect(invoke("pr-draft", { provider: "anthropic", modelId: "haiku" })).resolves.toEqual({ title: "Add the feature", body: "## Summary\nIt works.", base: "main", generated: true });
    const failing = await harness({ complete: async () => { throw new Error("no model"); } });
    await expect(failing.invoke("pr-draft")).resolves.toMatchObject({ title: "feat: add it", generated: false });
    expect(parseDraft("```markdown\nTitle: Fix it\n\nBody\n```")).toEqual({ title: "Fix it", body: "Body" });
    expect(fallbackDraft({ root: "/", base: "main", branch: "feat/make-it-work", commits: [] }).title).toBe("Make it work");
  });

  it("adds the user's instructions to the draft and leaves the template out when asked to", async () => {
    const { invoke, complete } = await harness({ context: { template: "## What\n\n## Why" } });
    await invoke("pr-draft", { instructions: "Write in German." });
    const first = (complete.mock.calls as unknown as Array<[{ system: string; prompt: string }]>)[0]![0];
    expect(first.system).toMatch(/instructions follow[\s\S]*Write in German\.$/u);
    expect(first.prompt).toContain("Template:\n## What");
    await invoke("pr-draft", { template: false });
    const second = (complete.mock.calls as unknown as Array<[{ system: string; prompt: string }]>)[1]![0];
    expect(second.prompt).not.toContain("Template:");
    expect(second.system).not.toMatch(/instructions follow/u);
  });

  it("pushes, then creates a draft request against the base", async () => {
    const { invoke, calls, pushes } = await harness({ cli: (args) => (args[1] === "create" ? "https://github.com/acme/tau/pull/7\n" : "") });
    const result = await invoke("pr-create", { title: "Add it", body: "Why", draft: true }) as { status: ReviewRequestStatus; url?: string };
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual(["pr", "create", "--title", "Add it", "--body", "Why", "--base", "main", "--head", "feature/pr", "--draft"]);
    expect(result).toMatchObject({ url: "https://github.com/acme/tau/pull/7", status: { request: { number: 7, draft: true } } });
  });

  it("refuses to create a second request or one into its own branch", async () => {
    await expect((await harness({ request: OPEN })).invoke("pr-create", { title: "Again" })).rejects.toThrow("PR #7 is already open");
    await expect((await harness({ context: { base: "feature/pr" } })).invoke("pr-create", { title: "Self" })).rejects.toThrow("into itself");
    await expect((await harness()).invoke("pr-create", { title: " " })).rejects.toThrow("A title is required.");
  });

  it("explains a create the CLI rejected", async () => {
    const { invoke } = await harness({ cli: (args) => { if (args[1] === "create") throw new Error("a pull request for branch \"feature/pr\" into branch \"main\" already exists:\nhttps://github.com/acme/tau/pull/6"); return ""; } });
    await expect(invoke("pr-create", { title: "Add it" })).rejects.toThrow("A pull request for this branch already exists.");
  });

  it("merges an open request with the chosen method and refuses a merged one", async () => {
    const { invoke, calls } = await harness({ request: { ...OPEN, draft: false } });
    await expect(invoke("pr-merge", { method: "fast" })).rejects.toThrow("Choose squash, merge or rebase.");
    await expect(invoke("pr-merge", { method: "squash" })).resolves.toMatchObject({ request: { state: "merged" } });
    expect(calls).toContainEqual(["pr", "merge", "7", "--squash"]);
    await expect(invoke("pr-merge", { method: "squash" })).rejects.toThrow("PR #7 is merged.");
    await expect((await harness()).invoke("pr-merge", { method: "merge" })).rejects.toThrow("no pull request yet");
  });

  it("passes a failed merge through in the tool's words", async () => {
    const { invoke } = await harness({ request: OPEN, cli: (args) => { if (args[1] === "merge") throw new Error("Pull request acme/tau#7 is still a draft"); return ""; } });
    await expect(invoke("pr-merge", { method: "merge" })).rejects.toThrow("Merging PR #7 failed: Pull request acme/tau#7 is still a draft");
  });

  it("edits title and body and flips the draft state", async () => {
    const { invoke, calls } = await harness({ request: OPEN });
    await invoke("pr-edit", { title: "Better", body: "Longer", draft: false });
    expect(calls).toContainEqual(["pr", "edit", "7", "--title", "Better", "--body", "Longer"]);
    expect(calls).toContainEqual(["pr", "ready", "7"]);
    const { invoke: again, calls: glab } = await harness({
      request: { ...OPEN, provider: "gitlab", draft: false },
      context: { remote: { name: "origin", url: "https://gitlab.com/acme/tau.git" } },
      tools: { glab: "/bin/glab" },
    });
    await again("pr-edit", { draft: true });
    expect(glab).toContainEqual(["mr", "update", "7", "--draft"]);
    expect(glab.some((args) => args[1] === "update" && args.includes("--title"))).toBe(false);
  });

  it("answers a rail row with only the request of the named workspace", async () => {
    const { invoke } = await harness({ request: OPEN });
    await expect(invoke("pr-status", { workspace: "/project-worktree" })).resolves.toEqual({ request: OPEN });
  });

  it("words the failures a CLI reports", () => {
    expect(explainCliFailure("gitlab", "Creating", new Error("401 Unauthorized"))).toMatch(/glab auth login/u);
    expect(explainCliFailure("github", "Creating", new Error("none of the git remotes configured for this repository point to a known GitHub host"))).toMatch(/does not know this repository's remote/u);
  });
});
