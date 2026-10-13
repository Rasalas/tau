import { describe, expect, it } from "vitest";
import type { ThreadPullRequestLink } from "./protocol.js";
import { threadPullRequestsParams, threadRequestTree, type ThreadRequestNode } from "./thread-request-tree.js";

const request = (number: number, headRef: string, baseRef: string, patch: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({ service: "gitlab", host: "gitlab.com", repo: "acme/app", url: `https://gitlab.com/acme/app/-/merge_requests/${number}`, number, headRef, baseRef, linkedAt: number, source: "agent", ...patch });
const shape = (nodes: ThreadRequestNode<ThreadPullRequestLink>[]): unknown[] => nodes.map((node) => [node.request.number, shape(node.children)]);

describe("the thread's branch dependencies", () => {
  it("keeps independent roots newest first, with sibling and deeper dependencies under their bases", () => {
    expect(shape(threadRequestTree([request(3, "cards", "buttons"), request(4, "layout", "cards"), request(1, "buttons", "main"), request(6, "scripts", "main"), request(5, "icons", "buttons")]))).toEqual([[6, []], [1, [[5, []], [3, [[4, []]]]]]]);
  });
  it("compares branch names exactly and never joins repositories, hosts or providers", () => {
    const base = request(1, "Feature", "main");
    const others = [request(2, "a", "feature"), request(3, "b", "Feature", { repo: "acme/other" }), request(4, "c", "Feature", { host: "gitlab.example.com" }), request(5, "d", "Feature", { service: "github" }), request(6, "e", "Feature", { repo: "ACME/APP", host: "GITLAB.COM" })];
    expect(shape(threadRequestTree([base, ...others]))).toEqual([[5, []], [4, []], [3, []], [2, []], [1, [[6, []]]]]);
  });
  it("keeps ambiguous heads and unknown branches at the root", () => {
    expect(shape(threadRequestTree([request(1, "same", "main"), request(2, "same", "main"), request(3, "child", "same"), request(4, "", "")]))).toEqual([[4, []], [3, []], [2, []], [1, []]]);
  });
  it("breaks cycles without losing their dependants or duplicating a request", () => {
    const a = request(1, "a", "b");
    expect(shape(threadRequestTree([a, request(2, "b", "a"), request(3, "c", "b"), a]))).toEqual([[2, [[3, []]]], [1, []]]);
    expect(shape(threadRequestTree([request(1, "a", "a")]))).toEqual([[1, []]]);
  });
  it("restores only tabs with a thread identity and a valid optional branch request", () => {
    expect(threadPullRequestsParams({})).toBeUndefined();
    expect(threadPullRequestsParams({ threadId: 3 })).toBeUndefined();
    expect(threadPullRequestsParams({ threadId: "t1", branchUrl: "https://example.com" })).toEqual({ threadId: "t1" });
  });
});
