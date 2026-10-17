import { describe, expect, it } from "vitest";
import { buildInbox, mergedStatus, openPulls, pairedPull, pullChecks, runChecks, type InboxPull } from "./inbox.js";
import type { LocalReview } from "./local-reviews.js";
import type { PullRequestListEntry } from "./protocol.js";

const review = (name: string, patch: Partial<LocalReview> = {}): LocalReview => ({
  key: `/repo\n${name}`, state: "ready", title: name, branch: name, target: "main", root: "/repo", path: `/work/${name}`, workspace: `ws-${name}`,
  project: { key: "ws-tau", name: "tau", root: "/repo" }, threadId: `t-${name}`, threads: 1, tip: `${name}-tip`, files: 2, added: 3, removed: 1,
  paths: [], uncommitted: 0, behind: 0, conflicts: [], at: 1_000, ...patch,
});

const entry = (number: number, patch: Partial<PullRequestListEntry> = {}): PullRequestListEntry => ({
  ref: { service: "github", host: "github.com", repo: "acme/tau", number, url: `https://github.com/acme/tau/pull/${number}` },
  title: `PR ${number}`, author: { login: "me" }, headRef: `branch-${number}`, baseRef: "main", state: "open", draft: false,
  additions: 1, deletions: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", labels: [], reviewRequested: false, ...patch,
});

const pull = (number: number, patch: Partial<PullRequestListEntry> = {}, mine = true): InboxPull => ({ entry: entry(number, patch), mine, workspace: "ws-tau" });
const ids = (sections: ReturnType<typeof buildInbox>) => sections.map((section) => [section.id, section.items.map((item) => item.key)]);

describe("the Reviews inbox", () => {
  it("sorts branches and requests into the next step, and leaves out empty sections", () => {
    const sections = buildInbox([
      review("ready"),
      review("clash", { state: "conflicts", conflicts: ["a.ts"] }),
      review("asked", { state: "requested", ask: { kind: "note", text: "x", at: 1, tip: "asked-tip" } }),
      review("done", { state: "merged" }),
    ], [
      pull(1, { checks: "passing" }),
      pull(2, { checks: "failing", checkRuns: [{ name: "a", status: "failed" }, { name: "b", status: "cancelled" }, { name: "c", status: "passed" }] }),
      pull(3, { mergeable: "conflicting" }),
      pull(4, { reviewDecision: "changes-requested" }),
      pull(5, { reviewRequested: true }, false),
      pull(6, {}, false),
      pull(7, { draft: true }),
      pull(8, { draft: true, reviewRequested: true }, false),
    ]);
    expect(ids(sections)).toEqual([
      ["ready", [entry(1).ref.url, review("ready").key]],
      ["review", [entry(5).ref.url]],
      ["thread", [entry(2).ref.url, entry(3).ref.url, entry(4).ref.url, review("clash").key, review("asked").key]],
    ]);
    const thread = sections.find((section) => section.id === "thread")!.items;
    expect(thread.map((item) => [item.action, item.status.text])).toEqual([
      ["open", "2 checks failed"], ["open", "Conflicts"], ["open", "Changes requested"], ["rebase", "Conflicts"], ["wait", "Note sent"],
    ]);
    expect(buildInbox([], [])).toEqual([]);
  });

  it("shows a branch with a request once, as the branch, with the request's state", () => {
    const branch = review("feat/x");
    const own = pull(9, { headRef: "feat/x", checks: "failing" });
    const sections = buildInbox([branch], [own, pull(10, { headRef: "feat/x" }, true)].map((item, index) => index ? { ...item, workspace: "ws-other" } : item));
    expect(ids(sections)).toEqual([["ready", [entry(10).ref.url]], ["thread", [branch.key]]]);
    const item = sections[1]!.items[0]!;
    expect(item).toMatchObject({ review: branch, pull: own, action: "fix", status: { text: "Checks failed" } });
    // A recorded request wins over a head match.
    expect(pairedPull(review("y", { request: { url: entry(11).ref.url, number: 11 } }), [pull(11, { headRef: "other" })])?.entry.ref.number).toBe(11);
    // A request in another project's repository is no match.
    expect(pairedPull(branch, [{ ...own, workspace: "ws-elsewhere" }])).toBeUndefined();
  });

  it("waits on running checks, and keeps a draft's branch ready with Draft for its status", () => {
    const sections = buildInbox([review("feat/d"), review("feat/r")], [pull(1, { headRef: "feat/d", draft: true }), pull(2, { headRef: "feat/r", checks: "pending" }), pull(3, { checks: "pending" })]);
    expect(sections[0]!.items.map((item) => [item.key, item.action, item.status.text])).toEqual([
      [review("feat/d").key, "merge", "Draft"],
      [entry(3).ref.url, "wait", "Checks running"],
      [review("feat/r").key, "wait", "Checks running"],
    ]);
  });

  it("reads checks from the request, else from the worktree's script runs", () => {
    expect(pullChecks(entry(1)).text).toBe("No checks");
    expect(pullChecks(entry(1, { checks: "failing", checkRuns: [{ name: "a", status: "failed" }] })).text).toBe("1 check failed");
    expect(runChecks([])).toMatchObject({ text: "No checks", tone: "muted" });
    expect(runChecks([{ status: "succeeded" }, { status: "running" }])).toMatchObject({ text: "Checks running" });
    expect(runChecks([{ status: "succeeded" }])).toMatchObject({ text: "Checks passed", tone: "ok" });
    const [ready] = buildInbox([review("r")], [], () => [{ status: "failed" }, { status: "failed" }]);
    expect(ready!.items[0]!.status).toMatchObject({ text: "2 checks failed", tone: "bad" });
  });

  it("marks the viewer's own requests per host, and keeps only open ones", () => {
    const pulls = openPulls({
      lists: [
        { service: "github", host: "github.com", repo: "acme/tau", viewer: "Me", entries: [entry(1), entry(2, { author: { login: "you" } }), entry(3, { state: "merged" })], truncated: false, limit: 100, workspaces: ["ws-tau"] },
        { service: "gitlab", host: "gitlab.com", repo: "acme/x", entries: [entry(4, { author: { login: "mona" }, viewer: "mona" })], truncated: false, limit: 100, workspaces: [] },
      ],
      failures: [],
    });
    expect(pulls.map((item) => [item.entry.ref.number, item.mine, item.workspace])).toEqual([[1, true, "ws-tau"], [2, false, "ws-tau"], [4, true, undefined]]);
  });

  it("says how a merged branch got in", () => {
    expect(mergedStatus(review("a", { state: "merged" })).text).toBe("Merged");
    expect(mergedStatus(review("a", { state: "merged", mergedBy: "request" })).text).toBe("Pull request merged");
    expect(mergedStatus(review("a", { state: "merged", mergedBy: "patches" })).text).toBe("Already in main");
  });
});
