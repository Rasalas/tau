import { describe, expect, it, vi } from "vitest";
import type { ThreadPullRequestLink } from "./protocol.js";
import { threadPullRequestsService } from "./pull-requests-service.js";

const link: ThreadPullRequestLink = { url: "https://github.com/o/r/pull/7", service: "github", host: "github.com", repo: "o/r", number: 7, source: "user", linkedAt: 1, title: "Fix it", state: "open", headRef: "fix/it", baseRef: "main" };

describe("the thread pull requests service", () => {
  it("reads a thread's links, hands them out without the kit's own fields, and keeps the array until they change", () => {
    let rows: readonly ThreadPullRequestLink[] = [link];
    const links = { ensure: vi.fn(), get: () => rows, subscribe: vi.fn(() => () => undefined) };
    const service = threadPullRequestsService(links);
    const first = service.forThread("t1");
    expect(links.ensure).toHaveBeenCalledWith("t1");
    expect(first).toEqual([{ url: link.url, number: 7, host: "github.com", repo: "o/r", title: "Fix it", state: "open", headRef: "fix/it", baseRef: "main" }]);
    expect(service.forThread("t1")).toBe(first);
    rows = [{ ...link, state: "merged" }];
    expect(service.forThread("t1")[0]?.state).toBe("merged");
  });
});
