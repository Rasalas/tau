import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type PullRequestDetail, type PullRequestList, type PullRequestThread, type ReviewRequestContext, type ReviewRequestStatus } from "./protocol.js";
import { azureRepository } from "./provider-azure.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { LINK_SEAMS } from "./test-seams.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const ORG = ["--organization", "https://dev.azure.com/powershell", "--output", "json", "--only-show-errors"];
const URL_46 = "https://dev.azure.com/powershell/PowerShell/_git/PowerShell/pullrequest/46";

interface Call { args: string[]; body?: unknown }

const stateRoots: string[] = [];
afterEach(async () => { await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** `az` answering from the recorded PowerShell project, the threads and policies in the API's documented shape. */
async function answer(args: string[]): Promise<string> {
  const verb = args.slice(0, 3).join(" ");
  if (args[0] === "account") return JSON.stringify({ user: { name: "mona@example.com", type: "user" } });
  if (verb === "repos show --project") return JSON.stringify({ id: "cc34", name: "PowerShell" });
  if (verb === "repos pr list") return fixture("azure-prs.json");
  if (verb === "repos pr show") return fixture("azure-pr.json");
  if (verb === "repos pr policy") return fixture("azure-policies.json");
  if (args[0] === "devops" && args.includes("pullRequestThreads") && args.includes("GET")) return fixture("azure-threads.json");
  if (args[0] === "devops" && args.includes("pullRequestCommits")) return fixture("azure-commits.json");
  if (verb === "repos pr create") return JSON.stringify({ pullRequestId: 60, status: "active" });
  return "{}";
}

async function harness(options: { tools?: Record<string, string>; context?: Partial<ReviewRequestContext>; fail?(args: string[]): string | undefined; rewrite?(args: string[], body: string): string } = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), "tau-azure-"));
  stateRoots.push(stateRoot);
  const calls: Call[] = [];
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
      context.registerCommand("review-request-context", () => ({
        root: "/project", branch: "invBootstrap", base: "master",
        remote: { name: "origin", url: "https://powershell@dev.azure.com/powershell/PowerShell/_git/PowerShell" },
        ...options.context,
      }), callers);
      context.registerCommand("push", () => ({}), callers);
    },
  };
  const run = vi.fn(async (_command: string, args: string[]) => {
    const file = args.includes("--in-file") ? args[args.indexOf("--in-file") + 1] : undefined;
    // The body file must exist while az reads it.
    const body = file ? JSON.parse(await readFile(file, "utf8")) as unknown : undefined;
    calls.push({ args, ...(body !== undefined ? { body } : {}) });
    const failed = options.fail?.(args);
    if (failed) throw new Error(failed);
    const reply = await answer(args);
    return options.rewrite ? options.rewrite(args, reply) : reply;
  });
  const tools = options.tools ?? { az: "/bin/az" };
  const registry = await activateHostKit(workspace, {
    ...LINK_SEAMS,
    findCommand: (name: string) => tools[name],
    noteSubprocess: () => undefined,
    stateDir: stateRoot,
    runtimeOwner: () => "tau",
  });
  await registry.activate(createReviewHostExtension({ run }));
  const invoke = <T = unknown>(command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input) as Promise<T>;
  return { invoke, calls };
}

describe("Azure DevOps remotes and request URLs", () => {
  it("reads every spelling of a repository as organization/project/repository", () => {
    expect(azureRepository("https://org@dev.azure.com/org/My%20Project/_git/tau")).toEqual({ host: "dev.azure.com", repo: "org/My Project/tau" });
    expect(azureRepository("git@ssh.dev.azure.com:v3/org/My%20Project/tau")).toEqual({ host: "dev.azure.com", repo: "org/My Project/tau" });
    expect(azureRepository("https://org.visualstudio.com/DefaultCollection/proj/_git/tau")).toEqual({ host: "org.visualstudio.com", repo: "org/proj/tau" });
    expect(azureRepository("org@vs-ssh.visualstudio.com:v3/org/proj/tau")).toEqual({ host: "org.visualstudio.com", repo: "org/proj/tau" });
    expect(azureRepository("https://github.com/o/r")).toBeUndefined();
    expect(parseRequestUrl(URL_46)).toEqual({ service: "azure-devops", host: "dev.azure.com", repo: "powershell/PowerShell/PowerShell", number: 46, url: URL_46 });
  });
});

describe("the Azure DevOps provider through az", () => {
  it("finds the branch's request with its policies as checks", async () => {
    const { invoke, calls } = await harness();
    const status = await invoke<ReviewRequestStatus>("pr-status");
    expect(status.problem).toBeUndefined();
    expect(status).toMatchObject({ service: "azure-devops", request: { provider: "azure-devops", number: 46, url: URL_46, baseRef: "master", headRef: "invBootstrap", state: "merged" } });
    expect(status.request?.checks).toEqual({ passed: 2, failed: 1, pending: 1, total: 4 });
    expect(calls.find((call) => call.args[2] === "list")!.args).toEqual(["repos", "pr", "list", "--project", "PowerShell", "--repository", "PowerShell", "--source-branch", "invBootstrap", "--status", "all", "--top", "10", ...ORG]);
  });

  it("names the extension when az lacks it, and the login when it is signed out", async () => {
    const noExtension = await harness({ fail: (args) => args[0] === "repos" && args[1] === "show" ? "ERROR: 'repos' is misspelled or not recognized by the system. Run `az extension add --name azure-devops`" : undefined });
    expect((await noExtension.invoke<ReviewRequestStatus>("pr-status")).problem).toMatch(/needs its DevOps extension/u);
    const signedOut = await harness({ fail: (args) => args[0] === "repos" && args[1] === "show" ? "ERROR: Please run 'az login' to setup account." : undefined });
    expect((await signedOut.invoke<ReviewRequestStatus>("pr-status")).problem).toMatch(/Azure CLI \(az\) is not signed in. Run `az login`/u);
  });

  it("creates a draft, merges by squash and refuses a rebase", async () => {
    const { invoke, calls } = await harness({ context: { branch: "feature/new" } });
    const created = await invoke<{ url?: string }>("pr-create", { title: "Add it", body: "Why", draft: true });
    expect(created.url).toBe("https://dev.azure.com/powershell/PowerShell/_git/PowerShell/pullrequest/60");
    expect(calls.find((call) => call.args[2] === "create")!.args).toEqual([
      "repos", "pr", "create", "--project", "PowerShell", "--repository", "PowerShell", "--source-branch", "feature/new", "--target-branch", "master",
      "--title", "Add it", "--description", "Why", "--draft", "true", ...ORG,
    ]);

    const open = await harness({ rewrite: (args, body) => args[2] === "list" ? body.replaceAll('"completed"', '"active"') : body });
    await expect(open.invoke("pr-merge", { method: "rebase" })).rejects.toThrow("Azure DevOps merges by squash or merge commit only.");
    await open.invoke("pr-merge", { method: "squash" });
    expect(open.calls.find((call) => call.args[2] === "update")!.args).toEqual(["repos", "pr", "update", "--id", "46", "--status", "completed", "--squash", "true", ...ORG]);
  });

  it("reads a request, its reviewers, policies, comments and conversations", async () => {
    const { invoke } = await harness();
    const detail = await invoke<PullRequestDetail>("pr-view", { url: URL_46 });
    expect(detail).toMatchObject({ state: "merged", baseRef: "master", headRef: "invBootstrap", headSha: "c6269c2837279c5d33654905e51969011e18e0a0", viewer: "mona@example.com" });
    expect(detail.checks.map((check) => [check.name, check.status])).toEqual([["CI", "passed"], ["Tests", "pending"], ["Minimum number of reviewers", "failed"], ["Comment requirements", "skipped"]]);
    // System threads stay out; a general thread's comments are the request's own.
    expect(detail.comments.map((comment) => comment.body)).toEqual(["Why a new cache?", "The old one leaked."]);
    expect(detail.commits).toHaveLength(1);
    const threads = await invoke<PullRequestThread[]>("pr-comments", { url: URL_46 });
    expect(threads).toEqual([
      expect.objectContaining({ id: "302", path: "src/app.ts", line: 12, side: "new", resolved: false }),
      expect.objectContaining({ id: "303", path: "README.md", line: 4, side: "old", resolved: true }),
    ]);
    await expect(invoke("pr-files", { url: URL_46 })).rejects.toThrow(/Azure DevOps does not let Tau read a request's diff/u);
  });

  it("writes comments, replies and resolutions through the threads API with a body file, and votes", async () => {
    const { invoke, calls } = await harness();
    await invoke("pr-comment", { url: URL_46, body: "Looks good." });
    const post = calls.find((call) => call.args.includes("POST"))!;
    expect(post.args.slice(0, 6)).toEqual(["devops", "invoke", "--area", "git", "--resource", "pullRequestThreads"]);
    expect(post.args).toEqual(expect.arrayContaining(["project=PowerShell", "repositoryId=PowerShell", "pullRequestId=46"]));
    expect(post.body).toEqual({ comments: [{ parentCommentId: 0, content: "Looks good.", commentType: 1 }], status: 1 });
    await invoke("pr-comment", { url: URL_46, threadId: "302", body: "Renamed." });
    expect(calls.at(-1)!.args).toEqual(expect.arrayContaining(["pullRequestThreadComments", "threadId=302"]));
    await invoke("pr-resolve", { url: URL_46, threadId: "302", resolved: true });
    expect(calls.find((call) => call.args.includes("PATCH"))!.body).toEqual({ status: "fixed" });
    await invoke("pr-review", { url: URL_46, event: "request-changes", body: "Not yet." });
    expect(calls.find((call) => call.args[2] === "set-vote")!.args.slice(0, 7)).toEqual(["repos", "pr", "set-vote", "--id", "46", "--vote", "wait-for-author"]);
    await expect(invoke("pr-review", { url: URL_46, event: "comment", body: "Hm." })).rejects.toThrow(/Azure DevOps takes no review without a verdict/u);
    await expect(invoke("pr-labels", { url: URL_46, add: ["x"] })).rejects.toThrow(/does not let Tau change the labels/u);
  });

  it("lists by status and narrows a search itself", async () => {
    const { invoke, calls } = await harness();
    const list = await invoke<PullRequestList>("pr-list", { state: "merged", limit: 2, search: "gardener" });
    expect(calls.find((call) => call.args[2] === "list")!.args).toEqual(expect.arrayContaining(["--status", "completed", "--top", "500"]));
    expect(list).toMatchObject({ service: "azure-devops", host: "dev.azure.com", repo: "powershell/PowerShell/PowerShell", truncated: false });
    expect(list.entries).toHaveLength(0);
    const all = await invoke<PullRequestList>("pr-list", { state: "merged", limit: 3 });
    expect(all.entries.map((entry) => entry.ref.number)).toEqual([54, 52, 50]);
    expect(all.truncated).toBe(true);
  });
});
