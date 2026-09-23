import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext, UiModel } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { evidenceRef } from "./evidence-upload.js";
import { evidenceToken, type LocalEvidence } from "./local-request.js";
import { REVIEW_HOST_EXTENSION_ID, type ReviewRequestContext } from "./protocol.js";
import { LINK_SEAMS } from "./test-seams.js";

const CONTEXT: ReviewRequestContext = {
  root: "/project",
  branch: "feature/pr",
  remote: { name: "origin", url: "git@github.com:acme/demo.git" },
  base: "main",
};

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
const BEFORE = { threadId: "t1", source: "tau.evidence", id: "f1", caption: "When the turn started" };
const AFTER = { threadId: "t1", source: "tau.evidence", id: "f2", caption: "Clicked “Save”" };

interface Fixture {
  context?: Partial<ReviewRequestContext>;
  visibility?: string;
  tools?: Record<string, string>;
  models?: UiModel[];
}

async function harness(fixture: Fixture = {}) {
  const calls: Array<{ args: string[]; input?: string; file?: string }> = [];
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      const callers = { callers: [REVIEW_HOST_EXTENSION_ID] };
      context.registerCommand("review-request-context", (input) => ({
        ...CONTEXT,
        ...fixture.context,
        ...((input as { detail?: boolean } | undefined)?.detail
          ? { commits: [{ subject: "feat: save", body: "", sha: "c2", at: 20_000, author: "Ada" }, { subject: "feat: start", body: "", sha: "c1", at: 10_000 }], forkedAt: 5_000, diffStat: " a.ts | 2 +-" }
          : {}),
      }), callers);
      context.registerCommand("push", () => ({ detail: "Pushed" }), callers);
    },
  };
  let created = false;
  const run = vi.fn(async (_command: string, args: string[], _cwd: string, options?: { input?: string }) => {
    const form = args.find((arg) => arg.startsWith("file=@"));
    calls.push({ args, ...(options?.input ? { input: options.input } : {}), ...(form ? { file: (await readFile(form.slice("file=@".length))).toString("base64") } : {}) });
    if ((args[0] === "pr" || args[0] === "mr") && args[1] === "view") {
      if (!created) throw new Error("no pull requests found");
      return JSON.stringify({ number: 7, title: "Save", url: "https://github.com/acme/demo/pull/7", baseRefName: "main", state: "OPEN" });
    }
    if (args[0] === "pr" && args[1] === "create") { created = true; return "https://github.com/acme/demo/pull/7\n"; }
    if (args[0] === "mr" && args[1] === "create") return "https://gitlab.com/acme/demo/-/merge_requests/3\n";
    if (args[0] !== "api") return "";
    const path = args.find((arg) => arg.startsWith("repos/") || arg.startsWith("projects/")) ?? "";
    if (path === "repos/acme/demo") return JSON.stringify({ visibility: fixture.visibility ?? "public", private: fixture.visibility === "private" });
    if (path.includes("/git/matching-refs/")) return "[]";
    if (path.endsWith("/git/blobs")) return JSON.stringify({ sha: `blob${calls.filter((call) => call.args.includes("repos/acme/demo/git/blobs")).length}` });
    if (path.endsWith("/git/trees")) return JSON.stringify({ sha: "tree1" });
    if (path.endsWith("/git/commits")) return JSON.stringify({ sha: "commit1" });
    if (path.endsWith("/git/refs")) return JSON.stringify({ ref: evidenceRef("feature/pr") });
    if (path.endsWith("/uploads")) return JSON.stringify({ url: `/uploads/secret${calls.length}/picture.jpg`, markdown: "ignored" });
    if (path.endsWith("/comments")) return "{}";
    return "{}";
  });
  const complete = vi.fn(async () => "Save the page\n\n## Summary\nIt saves.");
  const attachments: LocalEvidence[] = [
    { ...BEFORE, turnId: "turn1", turnStartedAt: 9_000, turnEndedAt: 15_000, at: 9_000, mediaType: "image/jpeg", size: 7, width: 960, height: 600 },
    { ...AFTER, turnId: "turn1", turnStartedAt: 9_000, turnEndedAt: 15_000, at: 14_000, mediaType: "image/jpeg", size: 7, width: 960, height: 600 },
  ];
  const registry = await activateHostKit(workspace, {
    ...LINK_SEAMS,
    findCommand: (name: string) => (fixture.tools ?? { gh: "/bin/gh", glab: "/bin/glab", git: "/usr/bin/git" })[name],
    noteSubprocess: () => undefined,
    runtimeOwner: () => "tau",
    complete,
    completionModels: async () => fixture.models ?? [],
    sessions: { list: async () => [{ sessionId: "t1", path: "/s/t1.jsonl", cwd: "/project" }, { sessionId: "elsewhere", path: "/s/e.jsonl", cwd: "/other" }] } as never,
    turnAttachments: {
      provide: () => () => undefined,
      changed: () => undefined,
      observe: () => () => undefined,
      list: async (threadId: string) => threadId === "t1" ? attachments.map(({ threadId: _thread, ...entry }) => entry) : [],
      read: async (_threadId: string, _source: string, id: string) => (id === "f1" || id === "f2" ? { mediaType: "image/jpeg", data: JPEG } : undefined),
    },
  });
  await registry.activate(createReviewHostExtension({ run }));
  const invoke = (command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input);
  return { invoke, calls, complete };
}

const body = `## Summary\nIt saves.\n\n## Screenshots\n\n${evidenceToken(BEFORE)}\n${evidenceToken(AFTER)}\n`;

describe("the local pull request's host commands", () => {
  it("names the branch's commits and reads the pictures of the checkout's threads", async () => {
    const { invoke } = await harness();
    await expect(invoke("local-pr")).resolves.toMatchObject({ branch: "feature/pr", base: "main", forkedAt: 5_000, commits: [{ sha: "c2", author: "Ada" }, { sha: "c1" }] });
    const answer = await invoke("local-pr-evidence", { root: "/project", threads: ["other-thread"] }) as { available: boolean; evidence: LocalEvidence[] };
    expect(answer.available).toBe(true);
    expect(answer.evidence.map((entry) => [entry.threadId, entry.id, entry.turnId])).toEqual([["t1", "f1", "turn1"], ["t1", "f2", "turn1"]]);
    await expect(invoke("local-pr-image", { threadId: "t1", source: "tau.evidence", id: "f1" })).resolves.toBe(`data:image/jpeg;base64,${JPEG}`);
  });

  it("writes the description with a small model near the thread's, naming the pictures", async () => {
    const models = [{ provider: "openai", id: "gpt-5.6-sol" }, { provider: "openai", id: "gpt-5.6-luna" }, { provider: "anthropic", id: "claude-haiku-4-5" }] as UiModel[];
    const { invoke, complete } = await harness({ models });
    await expect(invoke("local-pr-describe", { prefer: { provider: "openai", id: "gpt-5.6-sol" }, evidence: ["Clicked “Save”"] }))
      .resolves.toMatchObject({ title: "Save the page", body: "## Summary\nIt saves.", generated: true, model: "openai/gpt-5.6-luna" });
    const [request, model] = complete.mock.calls[0] as unknown as [{ prompt: string }, unknown];
    expect(model).toEqual({ provider: "openai", id: "gpt-5.6-luna" });
    expect(request.prompt).toContain("- Clicked “Save”");
    await invoke("local-pr-describe", { model: { provider: "anthropic", id: "claude-haiku-4-5" }, prefer: { provider: "openai", id: "gpt-5.6-sol" } });
    expect((complete.mock.calls[1] as unknown as [unknown, unknown])[1]).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("uploads a public GitHub repository's pictures to a ref of their own, then creates the request with the links", async () => {
    const { invoke, calls } = await harness();
    await expect(invoke("local-pr-upload-plan")).resolves.toEqual({ kind: "github-ref", destination: "refs/tau/evidence/feature/pr in github.com/acme/demo" });
    await expect(invoke("pr-create", { title: "Save", body })).rejects.toThrow("Confirm what is uploaded first.");
    expect(calls.some((call) => call.args.includes("repos/acme/demo/git/blobs"))).toBe(false);
    await expect(invoke("pr-create", { title: "Save", body, uploadConfirmed: true })).resolves.toMatchObject({ uploaded: 2, kept: 0 });
    const blobs = calls.filter((call) => call.args.includes("repos/acme/demo/git/blobs"));
    expect(blobs.map((call) => JSON.parse(call.input!) as unknown)).toEqual([{ content: JPEG, encoding: "base64" }, { content: JPEG, encoding: "base64" }]);
    const tree = JSON.parse(calls.find((call) => call.args.includes("repos/acme/demo/git/trees"))!.input!) as { tree: Array<{ path: string; sha: string }> };
    expect(tree.tree.map((entry) => entry.path)).toEqual([expect.stringMatching(/^\d{8}-\d{6}\/01-when-the-turn-started\.jpg$/u), expect.stringMatching(/\/02-clicked-save\.jpg$/u)]);
    expect(JSON.parse(calls.find((call) => call.args.includes("repos/acme/demo/git/refs"))!.input!)).toEqual({ ref: "refs/tau/evidence/feature/pr", sha: "commit1" });
    const create = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create")!.args;
    const sent = create[create.indexOf("--body") + 1]!;
    expect(sent).toContain("![When the turn started](https://github.com/acme/demo/raw/commit1/");
    expect(sent).not.toContain("tau-evidence://");
  });

  it("keeps a private GitHub repository's pictures on this machine and takes them out of the description", async () => {
    const { invoke, calls } = await harness({ visibility: "private" });
    await expect(invoke("local-pr-upload-plan")).resolves.toMatchObject({ kind: "none", reason: expect.stringMatching(/no upload API.*private/u) });
    await expect(invoke("pr-create", { title: "Save", body, uploadConfirmed: true })).resolves.toMatchObject({ uploaded: 0, kept: 2 });
    expect(calls.some((call) => call.args.some((arg) => arg.includes("/git/")))).toBe(false);
    const create = calls.find((call) => call.args[1] === "create")!.args;
    expect(create[create.indexOf("--body") + 1]).toBe("## Summary\nIt saves.");
  });

  it("uploads to GitLab's uploads API with the picture's bytes and links what it answers", async () => {
    const { invoke, calls } = await harness({ context: { remote: { name: "origin", url: "https://gitlab.com/acme/demo.git" } } });
    await expect(invoke("local-pr-upload-plan")).resolves.toEqual({ kind: "gitlab-uploads", destination: "the uploads of gitlab.com/acme/demo" });
    await invoke("pr-create", { title: "Save", body, uploadConfirmed: true });
    const uploads = calls.filter((call) => call.args.includes("projects/acme%2Fdemo/uploads"));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.args).toEqual(expect.arrayContaining(["--hostname", "gitlab.com", "--method", "POST", "--form"]));
    expect(uploads[0]!.file).toBe(JPEG);
    const create = calls.find((call) => call.args[0] === "mr" && call.args[1] === "create")!.args;
    expect(create[create.indexOf("--description") + 1]).toMatch(/!\[When the turn started\]\(\/uploads\/secret\d+\/picture\.jpg\)/u);
  });

  it("attaches pictures to an open request as a comment, only once confirmed", async () => {
    const { invoke, calls } = await harness();
    const comment = `Screenshots from Tau\n\n${evidenceToken(AFTER)}`;
    await expect(invoke("pr-attach-evidence", { url: "https://github.com/acme/demo/pull/7", body: comment })).rejects.toThrow("Confirm");
    await expect(invoke("pr-attach-evidence", { url: "https://github.com/acme/demo/pull/7", body: comment, branch: "feature/pr", uploadConfirmed: true })).resolves.toEqual({ uploaded: 1 });
    const posted = calls.find((call) => call.args.some((arg) => arg.includes("comment")) || call.args.includes("repos/acme/demo/issues/7/comments"));
    expect(JSON.stringify(posted)).toContain("https://github.com/acme/demo/raw/commit1/");
    const privateRepo = await harness({ visibility: "private" });
    await expect(privateRepo.invoke("pr-attach-evidence", { url: "https://github.com/acme/demo/pull/7", body: comment, uploadConfirmed: true })).rejects.toThrow(/private/u);
  });
});
