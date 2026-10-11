import { describe, expect, it } from "vitest";
import { applyCommentFilter, filterTimelineComments, isFinished } from "./comment-filter.js";
import type { PullRequestComment, PullRequestDetail } from "./protocol.js";

const comment = (id: string, extra: Partial<PullRequestComment> & { bot?: boolean } = {}): PullRequestComment => ({
  id, kind: "comment", author: { login: extra.bot ? "ci[bot]" : "mona", bot: extra.bot === true }, body: id, createdAt: "2026-10-01T00:00:00Z",
  ...(extra.verdict ? { verdict: extra.verdict } : {}),
});

const NOTHING = { bots: false, resolved: false };

describe("the comment filter", () => {
  const entries = [
    { comment: comment("human") },
    { comment: comment("bot", { bot: true }) },
    { comment: comment("done"), thread: { resolved: true } },
    { comment: comment("dismissed", { verdict: "dismissed" }) },
    { comment: comment("done bot", { bot: true }), thread: { resolved: true } },
  ];

  it("takes bots and finished conversations out by default and counts each comment once", () => {
    const { shown, hidden } = applyCommentFilter(entries, NOTHING, (entry) => entry);
    expect(shown.map((entry) => entry.comment.id)).toEqual(["human"]);
    expect(hidden).toBe(4);
  });

  it("lets each kind back in on its own; a resolved bot comment needs both", () => {
    const ids = (filter: typeof NOTHING) => applyCommentFilter(entries, filter, (entry) => entry).shown.map((entry) => entry.comment.id);
    expect(ids({ bots: true, resolved: false })).toEqual(["human", "bot"]);
    expect(ids({ bots: false, resolved: true })).toEqual(["human", "done", "dismissed"]);
    expect(ids({ bots: true, resolved: true })).toHaveLength(5);
  });

  it("calls a comment finished on a resolved thread or a dismissed review", () => {
    expect(isFinished(comment("a"), { resolved: true })).toBe(true);
    expect(isFinished(comment("b", { verdict: "dismissed" }))).toBe(true);
    expect(isFinished(comment("c"), { resolved: false })).toBe(false);
  });

  it("filters the comments of the timeline and leaves the detail alone when nothing is hidden", () => {
    const detail = { comments: [comment("human"), comment("bot", { bot: true })] } as unknown as PullRequestDetail;
    const hidden = filterTimelineComments(detail, NOTHING);
    expect(hidden.detail.comments.map((entry) => entry.id)).toEqual(["human"]);
    expect(hidden.hidden).toBe(1);
    const all = filterTimelineComments(detail, { bots: true, resolved: true });
    expect(all.detail).toBe(detail);
    expect(all.hidden).toBe(0);
  });
});
