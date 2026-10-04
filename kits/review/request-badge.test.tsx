// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSession } from "tau";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import type { ReviewRequest, ThreadPullRequestLink } from "./protocol.js";
import { aggregateState, createRequestBadge, createRequestCardSection, newestFirst } from "./request-badge.js";
import { PULL_REQUEST_TAB } from "./protocol.js";
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
    const badge = screen.getByRole("link", { name: "PR #35 open, checks 1 pending" });
    expect(badge.textContent).toBe("35");
    expect(badge.classList.contains("state-open")).toBe(true);
    expect(badge.querySelector("svg")).not.toBeNull();
    cleanup();
    // Every thread of a checkout reads its current branch; an older one may have worked on another.
    draw(older);
    expect(screen.queryByRole("link", { name: /PR #35/u })).toBeNull();
  });

  it("shows what a thread links on any of its rows, and several as the glyph and +N with the list in the tooltip", () => {
    const newest = thread("newest", 30);
    const older = thread("older", 10);
    const { draw } = setup([older, newest], { older: [link(40, { state: "merged" })], newest: [link(41, { state: "merged" }), link(42, { state: "closed" })] });
    draw(older);
    const single = screen.getByRole("link", { name: "PR #40 merged, linked" });
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

describe("a thread's requests on its hover card", () => {
  function Row({ icon, children, label, onClick }: { icon: ReactNode; children: ReactNode; label?: string; onClick?(event: import("react").MouseEvent<HTMLButtonElement>): void }) {
    return <button type="button" aria-label={label} onClick={onClick}>{icon}{children}</button>;
  }

  function drawCard(session: UiSession, threads: UiSession[], links: Record<string, ThreadPullRequestLink[]>, external = false) {
    const rows = new RowRequests(async () => REQUEST);
    rows.set("/project", REQUEST);
    const linkRows = new ThreadLinkRows({ links: async (id) => links[id] ?? [], onLinksChanged: () => () => undefined });
    for (const [id, list] of Object.entries(links)) linkRows.set(id, list);
    const Section = createRequestCardSection(rows, linkRows);
    const openStageTab = vi.fn(() => "tab");
    const openExternal = vi.fn();
    const actions = { openStageTab, openExternal } as never;
    render(<TestThreadStore threads={threads}><Section session={session} external={external} actions={actions} Row={Row} /></TestThreadStore>);
    return { openStageTab, openExternal };
  }

  it("lists the branch's request and the linked ones newest first, each with its state", () => {
    const newest = thread("newest", 30);
    drawCard(newest, [newest], { newest: [link(12, { state: "merged", title: "Older fix" }), link(41, { state: "closed", title: "Dropped" }), link(40, { draft: true, title: "Draft work" })] });
    const lines = screen.getAllByRole("listitem");
    expect(lines.map((line) => line.textContent)).toEqual(["#41 Dropped", "#40 Draft work", "#35 Rail badges", "#12 Older fix"]);
    expect(lines.map((line) => line.className.replace("request-card-line ", ""))).toEqual(["state-closed", "state-draft", "state-open", "state-merged"]);
    expect(screen.getByRole("button", { name: "PR #12, merged: Older fix" })).toBeTruthy();
  });

  it("opens a request's view on the stage", () => {
    const newest = thread("newest", 30);
    const { openStageTab } = drawCard(newest, [newest], {});
    fireEvent.click(screen.getByRole("button", { name: "PR #35, open: Rail badges" }));
    expect(openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, expect.objectContaining({ url: REQUEST.url, number: 35, service: "github", workspace: "/project" }), { key: REQUEST.url });
  });

  it.each(["metaKey", "ctrlKey"])("opens the hover card request in the browser with %s", (modifier) => {
    const newest = thread("newest", 30);
    const { openStageTab, openExternal } = drawCard(newest, [newest], {});
    fireEvent.click(screen.getByRole("button", { name: "PR #35, open: Rail badges" }), { [modifier]: true });
    expect(openExternal).toHaveBeenCalledWith(REQUEST.url);
    expect(openStageTab).not.toHaveBeenCalled();
  });

  it("draws nothing for a thread without requests or another machine's thread", () => {
    const older = thread("older", 10);
    drawCard(older, [older, thread("newest", 30)], {});
    expect(screen.queryByRole("list")).toBeNull();
    cleanup();
    const newest = thread("newest", 30);
    drawCard(newest, [newest], {}, true);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("orders by number, highest first", () => {
    expect(newestFirst([{ number: 3 }, { number: 17 }, { number: 9 }]).map((entry) => entry.number)).toEqual([17, 9, 3]);
  });
});
