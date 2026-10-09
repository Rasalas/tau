import { describe, expect, it } from "vitest";
import type { PullRequestWatch } from "./pr-watch-protocol.js";
import { watchRowStatuses } from "./pr-watch-rows.js";

const watch = (threadId: string, number: number, status: PullRequestWatch["status"] = "watching"): PullRequestWatch => ({
  threadId, status, startedAt: 1, wakes: 0, commentStreak: 0,
  ref: { service: "github", host: "github.com", repo: "o/r", number, url: `https://github.com/o/r/pull/${number}` },
});

describe("watchRowStatuses", () => {
  it("says Waiting for a thread that watches a request, naming every request it watches", () => {
    expect(watchRowStatuses([watch("a", 76), watch("a", 77)])).toEqual({
      a: { label: "Waiting", hint: "Watching #76, #77: wakes when checks finish, a review arrives or it merges." },
    });
  });

  it("leaves out ended and unreadable watches", () => {
    expect(watchRowStatuses([watch("a", 76, "ended"), watch("b", 5, "unreadable")])).toEqual({});
  });
});
