import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type PublishInfo, type ReviewRequestContext } from "./protocol.js";
import { githubCreatedRepository, gitlabCreatedRepository, isRepositoryPath } from "./request-cli.js";

const UNPUBLISHED: ReviewRequestContext = { root: "/work/app", branch: "main", base: "main" };

interface Fixture {
  context?: Partial<ReviewRequestContext>;
  hasCommits?: boolean;
  tools?: Record<string, string>;
  cli?(tool: string, args: string[]): string;
}

/** Workspace Kit's commands as Review reaches them, and each CLI as a function of its arguments. */
async function harness(fixture: Fixture = {}) {
  const remotes: string[] = [];
  const pushes = vi.fn();
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
      context.registerCommand("review-request-context", () => ({ ...UNPUBLISHED, ...fixture.context }), callers);
      context.registerCommand("add-remote", (input) => { remotes.push((input as { url: string }).url); return { hasCommits: fixture.hasCommits ?? true }; }, callers);
      context.registerCommand("push", () => { pushes(); return { detail: "Pushed" }; }, callers);
    },
  };
  const tools = fixture.tools ?? { gh: "/stub/gh", glab: "/stub/glab" };
  const calls: Array<{ tool: string; args: string[] }> = [];
  const run = vi.fn(async (command: string, args: string[]) => {
    const tool = command.split("/").at(-1)!;
    calls.push({ tool, args });
    if (fixture.cli) return fixture.cli(tool, args);
    if (args[0] === "api" && args[1] === "user") return tool === "gh" ? "octo\n" : JSON.stringify({ username: "lab" });
    if (args[0] === "repo" && args[1] === "create") return `https://github.com/${args[2]}\n`;
    return "";
  });
  const registry = await activateHostKit(workspace, { findCommand: (name: string) => tools[name], noteSubprocess: () => undefined, runtimeOwner: () => "tau" });
  await registry.activate(createReviewHostExtension({ run }));
  const invoke = (command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input);
  return { invoke, calls, remotes, pushes };
}

describe("publishing a repository", () => {
  it("names the CLIs that could publish it, as whom and over which protocol", async () => {
    const { invoke } = await harness({
      tools: { gh: "/stub/gh" },
      cli: (_tool, args) => (args[0] === "api" ? "octo" : args[0] === "config" ? "ssh\n" : ""),
    });
    await expect(invoke("publish-info")).resolves.toEqual({
      branch: "main",
      folder: "app",
      services: [
        { service: "github", ready: true, account: "octo", protocol: "ssh" },
        { service: "gitlab", ready: false, problem: "GitLab CLI (glab) is not installed." },
      ],
    } satisfies PublishInfo);
  });

  it("creates nothing without the form's confirmation", async () => {
    const { invoke, calls, remotes } = await harness();
    await expect(invoke("publish-repository", { service: "github", repository: "octo/app", visibility: "private" })).rejects.toThrow(/confirmation/u);
    expect(calls).toEqual([]);
    expect(remotes).toEqual([]);
  });

  it("creates it with gh, adds origin and pushes the branch", async () => {
    const { invoke, calls, remotes, pushes } = await harness();
    await expect(invoke("publish-repository", { service: "github", repository: "octo/app", visibility: "private", protocol: "https", confirm: true })).resolves.toEqual({
      repository: "octo/app", url: "https://github.com/octo/app", remote: "https://github.com/octo/app.git", pushed: true, branch: "main",
    });
    expect(calls).toContainEqual({ tool: "gh", args: ["repo", "create", "octo/app", "--private"] });
    expect(remotes).toEqual(["https://github.com/octo/app.git"]);
    expect(pushes).toHaveBeenCalledOnce();
  });

  it("creates it through GitLab's API in the named group, over SSH, and pushes nothing without a commit", async () => {
    const { invoke, calls, remotes, pushes } = await harness({
      hasCommits: false,
      cli: (_tool, args) => {
        if (args[1] === "namespaces/acme%2Ftools") return JSON.stringify({ id: 42 });
        if (args.includes("projects")) return JSON.stringify({ path_with_namespace: "acme/tools/app", web_url: "https://gitlab.com/acme/tools/app", http_url_to_repo: "https://gitlab.com/acme/tools/app.git", ssh_url_to_repo: "git@gitlab.com:acme/tools/app.git" });
        return "";
      },
    });
    const result = await invoke("publish-repository", { service: "gitlab", repository: "acme/tools/app", visibility: "public", protocol: "ssh", confirm: true });
    expect(result).toMatchObject({ repository: "acme/tools/app", remote: "git@gitlab.com:acme/tools/app.git", pushed: false });
    expect(calls).toContainEqual({ tool: "glab", args: ["api", "--method", "POST", "projects", "--raw-field", "path=app", "--raw-field", "name=app", "--raw-field", "visibility=public", "--raw-field", "namespace_id=42"] });
    expect(remotes).toEqual(["git@gitlab.com:acme/tools/app.git"]);
    expect(pushes).not.toHaveBeenCalled();
  });

  it("refuses a checkout that has a remote, a detached HEAD, a bad name and a signed-out CLI before creating anything", async () => {
    await expect((await harness({ context: { remote: { name: "origin", url: "x" } } })).invoke("publish-repository", { service: "github", repository: "a/b", confirm: true })).rejects.toThrow(/already has a remote/u);
    await expect((await harness({ context: { branch: undefined } })).invoke("publish-repository", { service: "github", repository: "a/b", confirm: true })).rejects.toThrow(/detached/u);
    await expect((await harness()).invoke("publish-repository", { service: "github", repository: "--help", confirm: true })).rejects.toThrow(/owner\/name/u);
    const signedOut = await harness({ cli: (_tool, args) => { if (args[0] === "auth") throw new Error("not logged in"); return ""; } });
    await expect(signedOut.invoke("publish-repository", { service: "github", repository: "a/b", confirm: true })).rejects.toThrow(/not signed in/u);
    expect(signedOut.calls.some((call) => call.args[1] === "create")).toBe(false);
  });

  it("says the repository exists when the push fails afterwards", async () => {
    const failingPush = await activateHostKit({
      id: "tau.workspace",
      name: "Workspace Kit",
      activate(context: HostExtensionContext) {
        const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
        context.registerCommand("review-request-context", () => UNPUBLISHED, callers);
        context.registerCommand("add-remote", () => ({ hasCommits: true }), callers);
        context.registerCommand("push", () => { throw new Error("Permission denied (publickey)."); }, callers);
      },
    }, { findCommand: () => "/stub/gh", noteSubprocess: () => undefined, runtimeOwner: () => "tau" });
    await failingPush.activate(createReviewHostExtension({ run: async (_command, args) => (args[1] === "create" ? "https://github.com/octo/app\n" : "") }));
    await expect(failingPush.invoke(REVIEW_HOST_EXTENSION_ID, "publish-repository", { service: "github", repository: "octo/app", confirm: true }))
      .rejects.toThrow("https://github.com/octo/app was created, but pushing to it failed: Permission denied (publickey).");
  });
});

describe("repository URLs", () => {
  it("reads what the CLIs print", () => {
    expect(githubCreatedRepository("✓ Created repository octo/app on GitHub\n  https://github.com/octo/app\n", "app")).toEqual({
      nameWithOwner: "octo/app", web: "https://github.com/octo/app", https: "https://github.com/octo/app.git", ssh: "git@github.com:octo/app.git",
    });
    expect(githubCreatedRepository("", "app")).toBeUndefined();
    expect(gitlabCreatedRepository("not json")).toBeUndefined();
    expect(isRepositoryPath("octo/app")).toBe(true);
    expect(isRepositoryPath("app")).toBe(true);
    expect(isRepositoryPath("-x/app")).toBe(false);
    expect(isRepositoryPath("octo/app.git")).toBe(false);
    expect(isRepositoryPath("octo//app")).toBe(false);
  });
});
