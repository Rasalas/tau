import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestCheck, PullRequestThread } from "./protocol.js";
import { parseGitHubDetail, parseRequestUrl, parseUnifiedDiff } from "./pull-request-json.js";
import {
  anchorThreads,
  asReviewRequest,
  buildTimeline,
  checksRollup,
  checksSummary,
  commentChip,
  lineKeys,
  orderFiles,
  pullRequestTabParams,
  relativeTime,
  threadChip,
  timelineCounts,
} from "./pull-request-logic.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const REF = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const check = (status: PullRequestCheck["status"], name: string = status): PullRequestCheck => ({ name, status });

describe("checks", () => {
  it("rolls up to the worst news and says it in one line", () => {
    expect(checksRollup([])).toBeUndefined();
    expect(checksSummary([])).toBe("No checks reported");
    expect(checksRollup([check("passed"), check("pending"), check("failed")])).toBe("failing");
    expect(checksSummary([check("passed"), check("pending"), check("cancelled")])).toBe("1 of 3 failing");
    expect(checksSummary([check("passed"), check("action-required")])).toBe("1 check awaiting action");
    expect(checksRollup([check("passed"), check("pending")])).toBe("pending");
    expect(checksSummary([check("passed"), check("pending")])).toBe("1 of 2 running");
    expect(checksRollup([check("passed"), check("skipped")])).toBe("passing");
    expect(checksSummary([check("passed"), check("skipped")])).toBe("1 of 2 passing");
    expect(checksSummary([check("passed"), check("passed", "b")])).toBe("All checks passed");
  });
});

describe("the view's request on the rail", () => {
  it("counts checks the way the rail's detector does", async () => {
    const detail = parseGitHubDetail(REF, await fixture("gh-pr-view-discussed.json"));
    expect(asReviewRequest(detail, detail.checks)).toMatchObject({
      provider: "github", number: 7, state: "open", draft: false, baseRef: "main", headRef: "feat/output",
      checks: { passed: 2, failed: 1, pending: 1, total: 4 },
    });
  });
});

describe("timeline", () => {
  it("folds runs of comments into conversations and keeps commits and verdicts as rows", async () => {
    const detail = parseGitHubDetail(REF, await fixture("gh-pr-view-discussed.json"));
    const oldest = buildTimeline(detail, true);
    expect(oldest.map((item) => item.kind)).toEqual(["commit", "opened", "conversation", "verdict"]);
    const conversation = oldest[2]!;
    expect(conversation.kind === "conversation" && conversation.comments.map((comment) => comment.id)).toEqual(["IC_1", "IC_2"]);
    expect(buildTimeline(detail).map((item) => item.kind)).toEqual(["verdict", "conversation", "opened", "commit"]);
    const merged = buildTimeline({ ...detail, state: "merged", mergedAt: "2026-09-22T00:00:00Z" });
    expect(merged[0]).toMatchObject({ kind: "merged" });
  });

  it("counts comments, commits and approvals", async () => {
    const detail = parseGitHubDetail(REF, await fixture("gh-pr-view-discussed.json"));
    const thread: PullRequestThread = { id: "t", path: "a.ts", line: 1, side: "new", resolved: false, outdated: false, comments: [detail.comments[0]!, detail.comments[1]!] };
    expect(timelineCounts(detail, [thread])).toEqual({ comments: 5, commits: 1, approvals: 0 });
  });
});

describe("threads on the diff", () => {
  it("anchors a thread on the line and side its number counts on, and lists the rest apart", async () => {
    const diffs = parseUnifiedDiff(await fixture("gh-pr-diff.patch")).map((entry) => entry.diff);
    const on: PullRequestThread = { id: "on", path: "kits/terminal/output.ts", line: 10, side: "new", resolved: false, outdated: false, comments: [] };
    const beyond: PullRequestThread = { ...on, id: "beyond", line: 400 };
    const outdated: PullRequestThread = { ...on, id: "outdated", outdated: true };
    const { anchored, loose } = anchorThreads([on, beyond, outdated], diffs);
    const output = diffs.find((diff) => diff.path === "kits/terminal/output.ts")!;
    const line = output.hunks[0]!.lines.find((candidate) => candidate.newLine === 10)!;
    expect(lineKeys(output.path, line).flatMap((key) => anchored.get(key) ?? []).map((thread) => thread.id)).toEqual(["on"]);
    expect(loose.map((thread) => thread.id)).toEqual(["beyond", "outdated"]);
  });
});

describe("file order", () => {
  it("puts each test after its source and generated files last", () => {
    const order = orderFiles(["package-lock.json", "src/b.test.ts", "src/a.ts", "src/__tests__/b.ts", "src/b.ts", "dist/x.js", "README.md"].map((path) => ({ path })));
    expect(order.map((file) => file.path)).toEqual(["README.md", "src/a.ts", "src/b.ts", "src/__tests__/b.ts", "src/b.test.ts", "dist/x.js", "package-lock.json"]);
  });
});

describe("small words", () => {
  it("reads tab params back only when they name a request", () => {
    expect(pullRequestTabParams({ url: REF.url, number: 7, service: "github" })).toEqual({ url: REF.url, number: 7, service: "github" });
    expect(pullRequestTabParams({ url: REF.url, number: "7", service: "github" })).toBeUndefined();
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-09-22T12:00:00Z");
    expect(relativeTime("2026-09-22T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-22T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-09-22T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-20T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-01-02T12:00:00Z", now)).toBe("2026-01-02");
    expect(relativeTime(undefined, now)).toBe("");
  });

  it("hands a comment and a thread to the composer as excerpts naming where they were said", async () => {
    const detail = parseGitHubDetail(REF, await fixture("gh-pr-view-discussed.json"));
    expect(commentChip(detail, detail.comments[0]!)).toEqual({ kind: "text-excerpt", label: "octo on PR #7", payload: { source: "octo's comment on PR #7", text: "Ready for a look." } });
    const thread: PullRequestThread = { id: "t", path: "kits/terminal/output.ts", line: 10, side: "new", resolved: false, outdated: false, comments: [detail.comments[0]!, detail.comments[2]!] };
    expect(threadChip(detail, thread)).toEqual({
      kind: "text-excerpt",
      label: "Thread on output.ts:10",
      payload: { source: "Review thread on PR #7 at kits/terminal/output.ts:10", text: "octo: Ready for a look.\n\nmona: Please name the offset." },
    });
  });
});
