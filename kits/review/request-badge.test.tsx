// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiSession } from "tau";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import type { ReviewRequest, ThreadPullRequestLink } from "./protocol.js";
import { aggregateState, createRequestBadge } from "./request-badge.js";
import { RowRequests } from "./requests.js";
import { ThreadLinkRows } from "./thread-links-store.js";

afterEach(cleanup);

const thread = (id: string, modifiedAt: number): UiSession => ({ id, path: `/s/${id}`, title: id, modifiedAt, projectPath: "/project", projectName: "project", projectLabel: "feat/x", messageCount: 2 });
const REQUEST = { provider: "github", number: 35, title: "Rail badges", url: "https://github.com/acme/tau/pull/35", baseRef: "main", state: "open", checks: { passed: 1, failed: 0, pending: 1, total: 2 } } as ReviewRequest;
const link = (number: number, patch: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({
  url: `https://github.com/acme/tau/pull/${number}`, service: "github", host: "github.com", repo: "acme/tau", number, source: "user", linkedAt: 1, state: "open", ...patch,
});

function setup(threads: UiSession[], links: Record<string, ThreadPullRequestLink[]> = {}) {
  const rows = new RowRequests(async () => REQUEST);
  rows.set("/project", REQUEST);
  const linkRows = new ThreadLinkRows({ links: async (id) => links[id] ?? [], onLinksChanged: () => () => undefined });
  for (const [id, list] of Object.entries(links)) linkRows.set(id, list);
  const Badge = createRequestBadge(rows, linkRows);
  const draw = (session: UiSession) => render(<TestThreadStore threads={threads}><Badge session={session} /></TestThreadStore>);
  return { draw };
}

describe("a thread's requests on its rail row", () => {
  it("shows the checkout's request only on the checkout's newest thread, as the state's glyph and the number", () => {
    const newest = thread("newest", 30);
    const older = thread("older", 10);
    const { draw } = setup([older, newest]);
    draw(newest);
    const badge = screen.getByRole("img", { name: "PR #35 open, checks 1 pending" });
    expect(badge.textContent).toBe("35");
    expect(badge.classList.contains("state-open")).toBe(true);
    expect(badge.querySelector("svg")).not.toBeNull();
    cleanup();
    // Every thread of a checkout reads its current branch; an older one may have worked on another.
    draw(older);
    expect(screen.queryByRole("img", { name: /PR #35/u })).toBeNull();
  });

  it("shows what a thread links on any of its rows, and several as the glyph and +N with the list in the tooltip", () => {
    const newest = thread("newest", 30);
    const older = thread("older", 10);
    const { draw } = setup([older, newest], { older: [link(40, { state: "merged" })], newest: [link(41, { state: "merged" }), link(42, { state: "closed" })] });
    draw(older);
    const single = screen.getByRole("img", { name: "PR #40 merged, linked" });
    expect(single.textContent).toBe("40");
    expect(single.classList.contains("state-merged")).toBe(true);
    cleanup();
    draw(newest);
    const several = screen.getByRole("img", { name: /^3 requests, open: PR #35 open, PR #41 merged, PR #42 closed$/u });
    expect(several.textContent).toBe("+3");
    expect(several.getAttribute("data-tooltip")).toContain("PR #42 · closed");
  });

  it("shows a stack as the layers glyph and its size", () => {
    const newest = thread("newest", 30);
    const { draw } = setup([newest], { newest: [link(50, { stack: { number: 3, size: 6 } }), link(51, { stack: { number: 3, size: 6 } })] });
    draw(newest);
    const badge = screen.getByRole("img", { name: /^Stack of 6 requests, open: /u });
    expect(badge.textContent).toBe("6");
    expect(badge.getAttribute("data-tooltip")).toContain("PR #50 · open · stack #3 of 6");
  });

  it("reads several requests as the one most alive", () => {
    expect(aggregateState(["merged", "closed"])).toBe("merged");
    expect(aggregateState(["closed", "draft", "merged"])).toBe("draft");
    expect(aggregateState(["merged", "open"])).toBe("open");
    expect(aggregateState(["closed"])).toBe("closed");
  });
});
