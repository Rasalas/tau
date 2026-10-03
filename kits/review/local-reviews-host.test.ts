import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostExtensionServices } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createWorkspaceHostExtension } from "../workspace/host.js";
import { noteThreads, registerLocalReviewCommands, summaryFromEntries } from "./local-reviews-host.js";
import { LOCAL_REVIEWS_EVENT, reviewKey, type ConflictFile, type LocalReviewsAnswer, type NoteThread, type ThreadBranchMerge } from "./local-reviews.js";
import type { BranchReviewRequest } from "./protocol.js";

const created: string[] = [];
afterEach(async () => { for (const path of created.splice(0)) await rm(path, { recursive: true, force: true }); });

/** A project with a thread's worktree beside it, as Workspace Kit's `create-worktree` leaves one. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-reviews-"));
  created.push(root);
  const project = join(root, "shop-api");
  await mkdir(project);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" }).toString().trim();
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "tau@example.com");
  git(project, "config", "user.name", "Tau");
  git(project, "config", "commit.gpgsign", "false");
  await writeFile(join(project, "a.txt"), "one\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "first");
  const worktree = join(root, "shop-api-worktrees", "tau-rate-limit");
  git(project, "worktree", "add", "-q", "-b", "tau/rate-limit", worktree, "main");
  await writeFile(join(worktree, "limit.ts"), "export const limit = 10;\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "feat: rate limit");
  return { root, project, worktree, git, stateDir: join(root, "state") };
}

/** Workspace Kit's host half, and the Reviews commands on a host half of their own under Review's id. */
async function hosts(stateDir: string, overrides: Partial<HostExtensionServices> = {}, requestFor?: (threadIds: readonly string[], branch: string, tip: string) => Promise<BranchReviewRequest | undefined>) {
  const events: PublishedKitEvent[] = [];
  const send = vi.fn(async () => undefined);
  const services: Partial<HostExtensionServices> = {
    cwd: () => "/nowhere",
    stateDir,
    knownWorkspacePath: async (id) => id.replace(/^ws1_/u, ""),
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "shop-api",
    rememberProjectName: () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      start: async () => { throw new Error("no threads in this test"); },
      send,
      exclusive: (work) => work(),
      remove: async () => undefined, restore: async () => undefined, trash: async () => [], purge: async () => undefined,
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    clients: { observe: () => () => undefined, count: () => 1 },
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    pickDirectory: async () => undefined,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    refreshExtensionPackages: async () => undefined,
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
    callClient: async () => { throw new Error("no window half in this test"); },
    ...overrides,
  };
  const registry = await activateHostKit(createWorkspaceHostExtension(), services, (event) => events.push(event));
  const reviews: HostExtension = {
    id: "tau.review",
    name: "Reviews",
    permissions: ["sessions"],
    activate(context) { registerLocalReviewCommands(context, (command, input) => context.invokeHostExtension("tau.workspace", command, input), requestFor); },
  };
  await registry.activate(reviews);
  const remote = remoteWorkStub();
  await registry.activate(remote.extension);
  const invoke = (command: string, input?: unknown) => registry.invoke("tau.review", command, input);
  return { invoke, events, send, remote };
}

/** Remote Work's four commands Reviews calls, over one link whose work came back as a branch. */
function remoteWorkStub() {
  const link = {
    id: "link-1", machineName: "rex", root: "/repo/shop-api", title: "Add pagination", parentThreadId: "here-1", transfer: "tr-1", status: "idle",
    model: { provider: "openai-codex", id: "gpt-5.6-luna" }, usage: { costUsd: 1.86 }, updatedAt: 42,
    result: { state: "branch" as const, branch: "tau/rex/pagination", tip: "abc", commits: 2, files: 3, paths: ["a.ts", "b.ts", "c.ts"], fetchedAt: 1 },
  } as Record<string, unknown>;
  const calls: Array<[string, unknown]> = [];
  const callers = { callers: ["tau.review"] };
  const extension: HostExtension = {
    id: "tau.remote-work",
    name: "Remote Work",
    permissions: [],
    activate(context) {
      context.registerCommand("threads", (input) => { calls.push(["threads", input]); return [link]; }, callers);
      context.registerCommand("preview", (input) => { calls.push(["preview", input]); return { transfer: "tr-1", branch: "tau/rex/pagination", clean: false, merged: false, conflicts: ["a.ts"] }; }, callers);
      context.registerCommand("thread-send", (input) => { calls.push(["thread-send", input]); return link; }, callers);
      context.registerCommand("thread-settle", (input) => {
        calls.push(["thread-settle", input]);
        Object.assign(link, { status: "settled", applied: { state: "merged", at: 1, files: [], detail: "Merged tau/rex/pagination.", commit: "m1" } });
        return link;
      }, callers);
    },
  };
  return { extension, calls, link };
}

describe("Reviews on the host", () => {
  it("lists a thread's worktree branch against the main checkout's, and merges it with a merge commit", async () => {
    const repo = await fixture();
    const { invoke, events } = await hosts(repo.stateDir);
    const answer = await invoke("local-reviews", { workspaces: [`ws1_${repo.worktree}`, `ws1_${repo.project}`] }) as LocalReviewsAnswer;
    expect(answer.branches).toHaveLength(1);
    const [branch] = answer.branches;
    expect(branch).toMatchObject({ branch: "tau/rate-limit", target: "main", ahead: 1, files: 1, added: 1, removed: 0, conflicts: [], merged: false, workspace: `ws1_${repo.worktree}` });

    const outcome = await invoke("local-review-merge", { workspace: branch!.workspace, tip: branch!.tip, threadId: "t1", title: "Rate limiting", files: 1, added: 1, removed: 0, costUsd: 1.12 }) as ThreadBranchMerge;
    expect(outcome).toMatchObject({ state: "merged", into: "main" });
    expect(repo.git(repo.project, "log", "-1", "--format=%s")).toBe("Merge branch 'tau/rate-limit'");
    expect(repo.git(repo.project, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(events.map((event) => event.name)).toContain(LOCAL_REVIEWS_EVENT);

    const after = await invoke("local-reviews", { workspaces: [`ws1_${repo.worktree}`] }) as LocalReviewsAnswer;
    expect(after.branches[0]).toMatchObject({ merged: true });
    expect(after.merged).toEqual([expect.objectContaining({ key: reviewKey(branch!.root, "tau/rate-limit"), threadId: "t1", title: "Rate limiting", costUsd: 1.12, target: "main" })]);
    expect(JSON.parse(await readFile(join(repo.stateDir, "tau.review", "local-reviews.json"), "utf8")).merged).toHaveLength(1);
  });

  it("touches nothing when the branch conflicts, and never pushes", async () => {
    const repo = await fixture();
    const bare = join(repo.root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    repo.git(repo.project, "remote", "add", "origin", bare);
    await writeFile(join(repo.project, "limit.ts"), "export const limit = 99;\n");
    repo.git(repo.project, "add", "-A");
    repo.git(repo.project, "commit", "-qm", "main moved");
    const head = repo.git(repo.project, "rev-parse", "HEAD");
    const { invoke } = await hosts(repo.stateDir);
    const [branch] = (await invoke("local-reviews", { workspaces: [`ws1_${repo.worktree}`] }) as LocalReviewsAnswer).branches;
    expect(branch?.conflicts).toEqual(["limit.ts"]);
    const outcome = await invoke("local-review-merge", { workspace: branch!.workspace, tip: branch!.tip }) as ThreadBranchMerge;
    expect(outcome).toMatchObject({ state: "conflict", files: ["limit.ts"] });
    expect(repo.git(repo.project, "rev-parse", "HEAD")).toBe(head);
    expect(repo.git(bare, "for-each-ref")).toBe("");
    expect((await invoke("local-reviews", { workspaces: [] }) as LocalReviewsAnswer).merged).toEqual([]);
  });

  it("sends the rebase ask to the thread, keeps it open until the branch moves, and lets it be withdrawn", async () => {
    const repo = await fixture();
    const { invoke, send } = await hosts(repo.stateDir);
    const workspaces = [`ws1_${repo.worktree}`];
    const [branch] = (await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches;
    await invoke("local-review-ask", { kind: "rebase", threadId: "t1", root: branch!.root, branch: branch!.branch, target: "main", tip: branch!.tip, conflicts: ["limit.ts"] });
    expect(send).toHaveBeenCalledWith("t1", expect.stringContaining("Please rebase `tau/rate-limit` onto `main` and resolve the conflicts in `limit.ts`."), { delivery: "prompt" });
    const key = reviewKey(branch!.root, branch!.branch);
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).asks[key]).toMatchObject({ kind: "rebase", tip: branch!.tip });

    await invoke("local-review-ask", { kind: "note", threadId: "t1", root: branch!.root, branch: branch!.branch, tip: branch!.tip, text: "retry budget" });
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).asks[key]).toMatchObject({ kind: "note", text: "retry budget" });
    await invoke("local-review-withdraw", { root: branch!.root, branch: branch!.branch });
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).asks[key]).toBeUndefined();

    await invoke("local-review-ask", { kind: "note", threadId: "t1", root: branch!.root, branch: branch!.branch, tip: branch!.tip, text: "again" });
    await writeFile(join(repo.worktree, "limit.ts"), "export const limit = 20;\n");
    repo.git(repo.worktree, "commit", "-qam", "answer the note");
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).asks[key]).toBeUndefined();
  });

  it("commits the worktree's uncommitted work on its branch and leaves the main checkout alone (Commit only)", async () => {
    const repo = await fixture();
    const { invoke } = await hosts(repo.stateDir);
    await writeFile(join(repo.worktree, "notes.md"), "draft\n");
    const workspaces = [`ws1_${repo.worktree}`];
    const head = repo.git(repo.project, "rev-parse", "HEAD");
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches[0]).toMatchObject({ uncommitted: 1 });
    await invoke("local-review-commit", { workspace: `ws1_${repo.worktree}`, message: "Rate limiting" });
    expect(repo.git(repo.worktree, "log", "-1", "--format=%s")).toBe("Rate limiting");
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches[0]).toMatchObject({ uncommitted: 0, ahead: 2 });
    expect(repo.git(repo.project, "rev-parse", "HEAD")).toBe(head);
  });

  it("reads a conflict's hunks and merges with a pick for each", async () => {
    const repo = await fixture();
    await writeFile(join(repo.project, "limit.ts"), "export const limit = 99;\n");
    repo.git(repo.project, "add", "-A");
    repo.git(repo.project, "commit", "-qm", "main moved");
    const { invoke } = await hosts(repo.stateDir);
    const [branch] = (await invoke("local-reviews", { workspaces: [`ws1_${repo.worktree}`] }) as LocalReviewsAnswer).branches;
    const read = await invoke("local-review-conflicts", { workspace: branch!.workspace }) as { tip: string; files: ConflictFile[] };
    expect(read.files).toEqual([{ path: "limit.ts", hunks: [{ main: ["export const limit = 99;"], thread: ["export const limit = 10;"], mainLine: 1, threadLine: 1, after: "" }] }]);
    const outcome = await invoke("local-review-merge", { workspace: branch!.workspace, tip: branch!.tip, picks: { "limit.ts": ["thread"] } }) as ThreadBranchMerge;
    expect(outcome).toMatchObject({ state: "merged", into: "main" });
    expect(await readFile(join(repo.project, "limit.ts"), "utf8")).toBe("export const limit = 10;\n");
    expect(repo.git(repo.project, "status", "--porcelain")).toBe("");
  });

  it("keeps notes sent from diff lines until the merge, with the thread's answer to each turn", async () => {
    const repo = await fixture();
    const transcript = vi.fn(async () => [
      { id: "1", role: "user" as const, text: "note", timestamp: Date.now() + 10 },
      { id: "2", role: "assistant" as const, text: "Yes — it dedupes by device id.", timestamp: Date.now() + 20 },
    ]);
    const { invoke } = await hosts(repo.stateDir, { thread: () => ({ transcript }) as unknown as ReturnType<HostExtensionServices["thread"]> });
    const [branch] = (await invoke("local-reviews", { workspaces: [`ws1_${repo.worktree}`] }) as LocalReviewsAnswer).branches;
    const where = { threadId: "t1", root: branch!.root, branch: branch!.branch, tip: branch!.tip };
    await invoke("local-review-ask", { kind: "note", ...where, text: "`limit.ts:1`\nDoes it dedupe?", notes: [{ id: "n1", path: "limit.ts", line: 1, side: "new", body: "Does it dedupe?" }] });
    expect((await invoke("local-reviews", { workspaces: [] }) as LocalReviewsAnswer).asks[reviewKey(branch!.root, branch!.branch)]).toMatchObject({ text: "Does it dedupe?" });
    const threads = await invoke("local-review-notes", where) as NoteThread[];
    expect(threads).toEqual([{ id: "n1", path: "limit.ts", line: 1, side: "new", said: [{ body: "Does it dedupe?", at: expect.any(Number), answer: "Yes — it dedupes by device id." }] }]);
    await invoke("local-review-merge", { workspace: branch!.workspace, tip: branch!.tip });
    expect(await invoke("local-review-notes", where)).toEqual([]);
  });

  it("counts a branch whose linked pull request merged, and removes its worktree and branch", async () => {
    const repo = await fixture();
    const sessions = { list: async () => [{ sessionId: "t1", path: "", cwd: repo.worktree }] } as unknown as HostExtensionServices["sessions"];
    const tip = repo.git(repo.worktree, "rev-parse", "HEAD");
    const requestFor = vi.fn(async (ids: readonly string[], branch: string) => ids.includes("t1") && branch === "tau/rate-limit"
      ? { target: "main", tip, merged: true, url: "https://github.com/acme/shop-api/pull/5", number: 5 } : undefined);
    const { invoke, events } = await hosts(repo.stateDir, { sessions }, requestFor);
    const workspaces = [`ws1_${repo.worktree}`];
    const [branch] = (await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches;
    expect(branch).toMatchObject({ ahead: 1, merged: true, mergedBy: "request" });

    await expect(invoke("local-review-remove", { workspace: branch!.workspace, tip: "old-tip" })).rejects.toThrow(/moved since/u);
    await invoke("local-review-remove", { workspace: branch!.workspace, tip, threadId: "t1", title: "Rate limit", costUsd: 1.25 });
    expect(repo.git(repo.project, "worktree", "list", "--porcelain")).not.toContain(repo.worktree);
    expect(repo.git(repo.project, "branch", "--list", "tau/rate-limit")).toBe("");
    const completed = (await invoke("local-reviews", { workspaces: [] }) as LocalReviewsAnswer).merged;
    expect(completed).toContainEqual(expect.objectContaining({ tip, threadId: "t1", title: "Rate limit", costUsd: 1.25 }));
    expect(events.map((event) => event.name)).toContain(LOCAL_REVIEWS_EVENT);
  });

  it("retains a precursor's completion when its squashed integration worktree disappears", async () => {
    const repo = await fixture();
    const submitted = join(repo.root, "submitted");
    repo.git(repo.project, "worktree", "add", "-q", "-b", "fix/submitted", submitted, "main");
    repo.git(submitted, "cherry-pick", "-x", repo.git(repo.worktree, "rev-parse", "HEAD"));
    await writeFile(join(submitted, "limit.ts"), "export const limit = 20;\n");
    repo.git(submitted, "commit", "-qam", "refine limit");
    repo.git(repo.project, "merge", "--squash", "fix/submitted");
    repo.git(repo.project, "commit", "-qm", "squashed work");
    await writeFile(join(repo.project, "limit.ts"), "export const limit = 30;\n");
    repo.git(repo.project, "commit", "-qam", "later revision");

    const first = await hosts(repo.stateDir);
    const workspaces = [`ws1_${repo.worktree}`, `ws1_${submitted}`];
    const done = await first.invoke("local-reviews", { workspaces }) as LocalReviewsAnswer;
    expect(done.branches).toHaveLength(2);
    expect(done.branches.every((branch) => branch.merged && branch.conflicts.length === 0)).toBe(true);
    expect(done.merged).toContainEqual(expect.objectContaining({ branch: "tau/rate-limit", tip: repo.git(repo.worktree, "rev-parse", "HEAD") }));

    repo.git(repo.project, "worktree", "remove", submitted);
    repo.git(repo.project, "branch", "-D", "fix/submitted");
    const restarted = await hosts(repo.stateDir);
    expect((await restarted.invoke("local-reviews", { workspaces: [workspaces[0]] }) as LocalReviewsAnswer).branches[0])
      .toMatchObject({ merged: true, conflicts: [] });
    await writeFile(join(repo.worktree, "new.ts"), "new work\n");
    repo.git(repo.worktree, "add", "-A");
    repo.git(repo.worktree, "commit", "-qm", "after integration");
    expect((await restarted.invoke("local-reviews", { workspaces: [workspaces[0]] }) as LocalReviewsAnswer).branches[0])
      .toMatchObject({ merged: false });
  });

  it("keeps a completed tip across host restarts, and reopens it after a new commit", async () => {
    const repo = await fixture();
    const workspaces = [`ws1_${repo.worktree}`];
    repo.git(repo.project, "merge", "--squash", "tau/rate-limit");
    repo.git(repo.project, "commit", "-qm", "squash");
    const first = await hosts(repo.stateDir);
    expect((await first.invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches[0]).toMatchObject({ target: "main", merged: true });

    // Even a later rewrite of the destination does not erase a recorded completion.
    repo.git(repo.project, "switch", "-q", "-c", "fix/privacy", "main~1");
    repo.git(repo.project, "branch", "-f", "main", "HEAD");
    const restarted = await hosts(repo.stateDir);
    const done = await restarted.invoke("local-reviews", { workspaces }) as LocalReviewsAnswer;
    expect(done.branches[0]).toMatchObject({ target: "main", merged: true });
    expect(done.merged[0]?.tip).toBe(repo.git(repo.worktree, "rev-parse", "HEAD"));

    await writeFile(join(repo.worktree, "new.ts"), "new work\n");
    repo.git(repo.worktree, "add", "-A");
    repo.git(repo.worktree, "commit", "-qm", "after merge");
    expect((await restarted.invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches[0]).toMatchObject({ target: "main", merged: false });
    await expect(restarted.invoke("local-review-remove", { workspace: workspaces[0] })).rejects.toThrow(/does not hold/u);
  });

  it("uses a linked request's destination and only completes its submitted tip", async () => {
    const repo = await fixture();
    repo.git(repo.project, "branch", "release");
    const submitted = repo.git(repo.worktree, "rev-parse", "HEAD");
    const sessions = { list: async () => [{ sessionId: "t1", path: "", cwd: repo.worktree }] } as unknown as HostExtensionServices["sessions"];
    const requestFor = async () => ({ target: "release", tip: submitted, merged: true, url: "https://github.com/acme/shop-api/pull/5", number: 5 });
    const { invoke } = await hosts(repo.stateDir, { sessions }, requestFor);
    const workspaces = [`ws1_${repo.worktree}`];
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches[0]).toMatchObject({ target: "release", merged: true, request: { number: 5 } });

    await writeFile(join(repo.worktree, "new.ts"), "new work\n");
    repo.git(repo.worktree, "add", "-A");
    repo.git(repo.worktree, "commit", "-qm", "after the request merged");
    expect((await invoke("local-reviews", { workspaces }) as LocalReviewsAnswer).branches[0]).toMatchObject({ target: "release", merged: false });
    await expect(invoke("local-review-remove", { workspace: workspaces[0] })).rejects.toThrow(/does not hold/u);
    await expect(invoke("local-review-merge", { workspace: workspaces[0] })).rejects.toThrow(/Check out release/u);
  });

  it("refuses to remove a branch the target lacks", async () => {
    const repo = await fixture();
    const { invoke } = await hosts(repo.stateDir);
    await expect(invoke("local-review-remove", { workspace: `ws1_${repo.worktree}` })).rejects.toThrow(/main does not hold tau\/rate-limit yet/u);
    expect(repo.git(repo.project, "branch", "--list", "tau/rate-limit")).toContain("tau/rate-limit");
  });

  it("refuses to merge a branch that moved since the page read it", async () => {
    const repo = await fixture();
    const { invoke } = await hosts(repo.stateDir);
    const [branch] = (await invoke("local-reviews", { workspaces: [`ws1_${repo.worktree}`] }) as LocalReviewsAnswer).branches;
    await writeFile(join(repo.worktree, "b.txt"), "b\n");
    repo.git(repo.worktree, "add", "-A");
    repo.git(repo.worktree, "commit", "-qm", "more");
    await expect(invoke("local-review-merge", { workspace: branch!.workspace, tip: branch!.tip })).rejects.toThrow(/moved since it was read/u);
  });
});

describe("work that came back from another machine", () => {
  it("lists it with Remote Work's merge check, sends a note through its link, and merges through its settle", async () => {
    const repo = await fixture();
    const { invoke, remote, send } = await hosts(repo.stateDir, { knownWorkspacePath: async (id) => (id === "/repo/shop-api" ? repo.project : id.replace(/^ws1_/u, "")) });
    const answer = await invoke("local-reviews", { workspaces: [] }) as LocalReviewsAnswer;
    expect(answer.remote).toEqual([expect.objectContaining({ link: "link-1", machine: "rex", target: "main", branch: "tau/rex/pagination", tip: "abc", files: 3, conflicts: ["a.ts"], costUsd: 1.86, model: "gpt-5.6-luna", threadId: "here-1" })]);

    await invoke("local-review-ask", { kind: "note", link: "link-1", root: "/repo/shop-api", branch: "tau/rex/pagination", tip: "abc", text: "keep the cursor opaque" });
    expect(send).not.toHaveBeenCalled();
    expect(remote.calls).toContainEqual(["thread-send", { link: "link-1", text: expect.stringContaining("keep the cursor opaque"), delivery: "prompt" }]);
    expect((await invoke("local-reviews", { workspaces: [] }) as LocalReviewsAnswer).asks["remote:link-1"]).toMatchObject({ kind: "note", tip: "abc" });

    const outcome = await invoke("local-review-merge", { link: "link-1", branch: "tau/rex/pagination", target: "main", title: "Add pagination", costUsd: 1.86 }) as ThreadBranchMerge;
    expect(outcome).toMatchObject({ state: "merged", branch: "tau/rex/pagination", into: "main", commit: "m1" });
    expect(remote.calls).toContainEqual(["thread-settle", { link: "link-1", how: "apply" }]);
    const after = await invoke("local-reviews", { workspaces: [] }) as LocalReviewsAnswer;
    expect(after.remote).toEqual([]);
    expect(after.merged).toEqual([expect.objectContaining({ key: "remote:link-1", title: "Add pagination", costUsd: 1.86 })]);
    expect(after.asks["remote:link-1"]).toBeUndefined();
  });
});

describe("a review's summary", () => {
  it("is the thread's last answer, with its prompts counted and named by their first line", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix it" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Looking." }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Go on\nand keep the tests green" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1" }, { type: "text", text: "The watcher subscribes on construction now." }] } },
    ];
    expect(summaryFromEntries(entries)).toEqual({ summary: "The watcher subscribes on construction now.", turns: 2, prompts: ["Fix it", "Go on"] });
  });
});

describe("a sent note's conversation", () => {
  it("pairs each turn with the thread's last words before the next prompt, and none while it has not answered", () => {
    const note = { id: "n1", note: "n1", path: "a.ts", line: 3, side: "new" as const, body: "Why?", at: 100 };
    const reply = { ...note, id: "n2", body: "And then?", at: 30_000 };
    const messages = [
      { role: "user", text: "Why?", at: 101 },
      { role: "assistant", text: "Looking.", at: 5_000 },
      { role: "assistant", text: "Because of the replay.", at: 6_000 },
      { role: "user", text: "And then?", at: 30_001 },
    ];
    expect(noteThreads([note, reply], messages)).toEqual([{ id: "n1", path: "a.ts", line: 3, side: "new", said: [
      { body: "Why?", at: 100, answer: "Because of the replay." },
      { body: "And then?", at: 30_000 },
    ] }]);
  });
});
