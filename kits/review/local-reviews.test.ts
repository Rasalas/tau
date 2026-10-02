import { describe, expect, it } from "vitest";
import type { UiSession } from "tau";
import {
  countReviews,
  deriveReviews,
  mergeBlocker,
  mergedThisMonth,
  needsYou,
  noteRequest,
  rebaseRequest,
  reviewKey,
  type LocalReviewsAnswer,
  type ThreadBranch,
} from "./local-reviews.js";

const branch = (name: string, patch: Partial<ThreadBranch> = {}): ThreadBranch => ({
  path: `/work/${name}`,
  root: "/repo/shop-api",
  branch: `tau/${name}`,
  target: "main",
  tip: `${name}-tip`,
  ahead: 2,
  behind: 0,
  files: 3,
  added: 59,
  removed: 5,
  paths: [{ path: "a.ts", added: 59, removed: 5 }],
  uncommitted: 0,
  committedAt: 1_000,
  merged: false,
  conflicts: [],
  workspace: `ws-${name}`,
  rootWorkspace: "ws-shop",
  ...patch,
});

const thread = (id: string, workspace: string, patch: Partial<UiSession> = {}): UiSession => ({
  id,
  path: `/sessions/${id}.jsonl`,
  title: `Thread ${id}`,
  modifiedAt: 2_000,
  projectPath: `/work/${id}`,
  workspaceId: workspace,
  projectName: "shop-api",
  messageCount: 4,
  modelProvider: "openai-codex",
  model: "gpt-5.6-luna",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.84, turns: 2 },
  ...patch,
});

const answer = (patch: Partial<LocalReviewsAnswer> = {}): LocalReviewsAnswer => ({ branches: [], asks: {}, merged: [], ...patch });

describe("which threads are local merge requests", () => {
  it("keeps a forked thread's source as its own review: the fork has a worktree and branch of its own", () => {
    // K160: a fork used to share its source's worktree, so the source's row took the fork's title and vanished.
    const reviews = deriveReviews({
      answer: answer({ branches: [branch("frost"), branch("frost-2", { tip: "frost-tip" })] }),
      threads: [thread("source", "ws-frost", { title: "Frost warning" }), thread("fork", "ws-frost-2", { title: "Frost warning, other way", modifiedAt: 3_000 })],
      busy: new Set(),
    });
    expect(reviews.map((review) => [review.branch, review.title, review.threadId])).toEqual([
      ["tau/frost-2", "Frost warning, other way", "fork"],
      ["tau/frost", "Frost warning", "source"],
    ]);
  });

  it("counts a branch the target holds under other commits as merged, and names a target off the default branch", () => {
    const reviews = deriveReviews({
      answer: answer({ branches: [branch("picked", { merged: true, mergedBy: "patches", defaultBranch: "main" }), branch("aside", { target: "feat/x", defaultBranch: "main" })] }),
      threads: [thread("p", "ws-picked"), thread("a", "ws-aside")],
      busy: new Set(),
    });
    expect(reviews.find((review) => review.branch === "tau/picked")).toMatchObject({ state: "merged", mergedBy: "patches" });
    expect(reviews.find((review) => review.branch === "tau/picked")?.offDefault).toBeUndefined();
    expect(reviews.find((review) => review.branch === "tau/aside")).toMatchObject({ state: "ready", offDefault: "main" });
  });

  it("takes a finished thread's worktree branch, in its state from Git", () => {
    const reviews = deriveReviews({
      answer: answer({ branches: [branch("ready"), branch("conflict", { conflicts: ["a.ts"] }), branch("merged", { ahead: 0, merged: true })] }),
      threads: [thread("r", "ws-ready"), thread("c", "ws-conflict"), thread("m", "ws-merged")],
      busy: new Set(),
    });
    expect(Object.fromEntries(reviews.map((review) => [review.branch, review.state]))).toEqual({ "tau/ready": "ready", "tau/conflict": "conflicts", "tau/merged": "merged" });
    expect(reviews[0]).toMatchObject({ title: "Thread r", target: "main", costUsd: 0.84, model: "gpt-5.6-luna", project: { key: "ws-shop", name: "shop-api" }, at: 2_000 });
  });

  it("leaves out a branch while a thread there works or asks, one without a thread, and one that did nothing", () => {
    const reviews = deriveReviews({
      answer: answer({ branches: [branch("busy"), branch("orphan"), branch("idle", { ahead: 0 })] }),
      threads: [thread("b", "ws-busy"), thread("i", "ws-idle")],
      busy: new Set(["b"]),
    });
    expect(reviews).toEqual([]);
  });

  it("counts uncommitted work as something to review, but not to merge", () => {
    const [review] = deriveReviews({ answer: answer({ branches: [branch("dirty", { ahead: 0, uncommitted: 2 })] }), threads: [thread("d", "ws-dirty")], busy: new Set() });
    expect(review?.state).toBe("ready");
    expect(mergeBlocker(review!)).toBe("2 files are not committed; ask the thread to commit first.");
  });

  it("reopens uncommitted work on a completed branch without its old completion metadata", () => {
    const [review] = deriveReviews({
      answer: answer({ branches: [branch("dirty", { merged: true, mergedBy: "request", ahead: 0, uncommitted: 1 })] }),
      threads: [thread("d", "ws-dirty")], busy: new Set(),
    });
    expect(review?.state).toBe("ready");
    expect(review?.mergedBy).toBeUndefined();
    expect(mergeBlocker(review!)).toContain("not committed");
    expect(countReviews([review!])).toMatchObject({ ready: 1, merged: 0 });
  });

  it("keeps completed work out of the open count while its target is not checked out", () => {
    const message = "Check out main before merging.";
    const [review] = deriveReviews({
      answer: answer({ branches: [branch("done", { merged: true, mergedBy: "squash", mergeBlocked: message })] }),
      threads: [thread("d", "ws-done")], busy: new Set(),
    });
    expect(review).toMatchObject({ state: "merged", target: "main", mergedBy: "squash" });
    expect(countReviews([review!])).toMatchObject({ ready: 0, conflicts: 0, merged: 1 });
    const [open] = deriveReviews({ answer: answer({ branches: [branch("open", { mergeBlocked: message })] }), threads: [thread("o", "ws-open")], busy: new Set() });
    expect(mergeBlocker(open!)).toBe(message);
  });

  it("holds a branch in Changes requested while an ask about its tip is open, and lets go once it moves", () => {
    const key = reviewKey("/repo/shop-api", "tau/asked");
    const ask = { kind: "note" as const, text: "retry budget", at: 5, tip: "asked-tip" };
    const threads = [thread("a", "ws-asked")];
    const open = deriveReviews({ answer: answer({ branches: [branch("asked", { conflicts: ["a.ts"] })], asks: { [key]: ask } }), threads, busy: new Set() });
    expect(open[0]).toMatchObject({ state: "requested", ask });
    const answered = deriveReviews({ answer: answer({ branches: [branch("asked", { tip: "new-tip" })], asks: { [key]: ask } }), threads, busy: new Set() });
    expect(answered[0]?.state).toBe("ready");
  });

  it("keeps a merge made from the page after its worktree and thread are gone", () => {
    const merged = { key: reviewKey("/repo/tau", "tau/old"), root: "/repo/tau", branch: "tau/old", target: "main", title: "Old work", at: 9_000, files: 2, added: 3, removed: 1, costUsd: 1.5, rootWorkspace: "ws-tau" };
    const reviews = deriveReviews({ answer: answer({ merged: [merged] }), threads: [], projects: [{ path: "/repo/tau", workspaceId: "ws-tau", name: "tau", lastOpenedAt: 0 }], busy: new Set() });
    expect(reviews[0]).toMatchObject({ state: "merged", title: "Old work", costUsd: 1.5, project: { name: "tau" }, at: 9_000 });
  });

  it("takes work that came back from another machine as its own row, with its machine", () => {
    const remote = { link: "l1", machine: "rex", root: "/repo/shop-api", rootWorkspace: "ws-shop", target: "main", title: "Add pagination", branch: "tau/rex/pagination", tip: "abc", commits: 2, files: 3, paths: ["a.ts"], conflicts: ["a.ts"], merged: false, costUsd: 1.86, at: 7 };
    const [review] = deriveReviews({ answer: answer({ remote: [remote] }), threads: [], busy: new Set() });
    expect(review).toMatchObject({ key: "remote:l1", state: "conflicts", remote: { link: "l1", machine: "rex" }, files: 3, paths: [{ path: "a.ts", added: 0, removed: 0 }], costUsd: 1.86 });
    const asked = deriveReviews({ answer: answer({ remote: [remote], asks: { "remote:l1": { kind: "note", text: "x", at: 1, tip: "abc" } } }), threads: [], busy: new Set() });
    expect(asked[0]?.state).toBe("requested");
  });

  it("sums the threads in one worktree and names the latest", () => {
    const [review] = deriveReviews({
      answer: answer({ branches: [branch("two")] }),
      threads: [thread("old", "ws-two", { modifiedAt: 1, title: "First" }), thread("new", "ws-two", { modifiedAt: 3_000, title: "Second" })],
      busy: new Set(),
    });
    expect(review).toMatchObject({ threadId: "new", title: "Second", threads: 2, costUsd: 1.68 });
  });
});

describe("the page's counts and footer", () => {
  it("counts states and open reviews per project; the badge counts what waits for the user", () => {
    const reviews = deriveReviews({
      answer: answer({
        branches: [branch("a"), branch("b", { conflicts: ["x"] }), branch("c", { root: "/repo/tau", rootWorkspace: "ws-tau" }), branch("d", { ahead: 0, merged: true })],
        asks: { [reviewKey("/repo/tau", "tau/c")]: { kind: "rebase", text: "", at: 1, tip: "c-tip" } },
      }),
      threads: [thread("a", "ws-a"), thread("b", "ws-b"), thread("c", "ws-c"), thread("d", "ws-d")],
      busy: new Set(),
    });
    const counts = countReviews(reviews);
    expect(counts).toMatchObject({ ready: 1, requested: 1, conflicts: 1, merged: 1 });
    expect(counts.projects).toEqual([{ key: "ws-shop", name: "shop-api", root: "/repo/shop-api", open: 2 }, { key: "ws-tau", name: "tau", root: "/repo/tau", open: 1 }]);
    expect(needsYou(counts)).toBe(2);
  });

  it("lists a project once when a merge record lacks the project's workspace", () => {
    // A merge from before records kept `rootWorkspace`: its key would be the path, beside the id of the open branch.
    const merged = { key: reviewKey("/repo/shop-api", "tau/old"), root: "/repo/shop-api", branch: "tau/old", target: "main", title: "Old", at: 9_000, files: 1, added: 1, removed: 0 };
    const inputs = { answer: answer({ branches: [branch("a")], merged: [merged] }), threads: [thread("a", "ws-a")], busy: new Set<string>() };
    expect(countReviews(deriveReviews(inputs)).projects).toEqual([{ key: "ws-shop", name: "shop-api", root: "/repo/shop-api", open: 1 }]);
    // Alone, it takes the id of the project the window knows at that path.
    const alone = deriveReviews({ ...inputs, answer: answer({ merged: [merged] }), projects: [{ path: "/repo/shop-api", workspaceId: "ws-shop", name: "shop-api", lastOpenedAt: 0 }] });
    expect(alone[0]?.project.key).toBe("ws-shop");
  });

  it("sums this month's merges and what their threads cost", () => {
    const now = new Date(2026, 8, 29, 12).getTime();
    const record = (key: string, at: number, costUsd: number) => ({ key, root: "/r", branch: key, target: "main", title: key, at, files: 1, added: 1, removed: 0, costUsd });
    const reviews = deriveReviews({
      answer: answer({ merged: [record("this", new Date(2026, 8, 2).getTime(), 9.3), record("last", new Date(2026, 7, 30).getTime(), 4)] }),
      threads: [],
      busy: new Set(),
    });
    expect(mergedThisMonth(reviews, now)).toEqual({ count: 1, costUsd: 9.3 });
  });
});

describe("what goes back to the thread", () => {
  it("asks for a rebase onto the target and names the conflicted files", () => {
    expect(rebaseRequest({ branch: "tau/x", target: "main", conflicts: ["a.ts", "b.ts"] }))
      .toBe("Please rebase `tau/x` onto `main` and resolve the conflicts in `a.ts`, `b.ts`. Keep your work, run the checks again and commit the result on this branch. Do not merge it yourself; it is merged from Reviews.");
    expect(noteRequest({ branch: "tau/x" }, "  retry budget  ")).toContain("asks for changes:\n\nretry budget\n\n");
  });
});
