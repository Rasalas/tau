// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSession, WorkbenchActions } from "tau";
import { RequestLinks } from "./request-links.js";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import type { ReviewRequest, ThreadPullRequestLink } from "./protocol.js";
import { aggregateState, createRequestBadge, createRequestCardSection } from "./request-badge.js";
import { PULL_REQUEST_TAB, THREAD_PULL_REQUESTS_TAB } from "./protocol.js";
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
  const draw = (session: UiSession, routes?: WorkbenchActions, selectThread?: () => void) => render(<TestThreadStore threads={threads}>{routes ? <RequestLinks actions={routes} /> : null}<div onClick={selectThread}><Badge session={session} /></div></TestThreadStore>);
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

  it("shows what a thread links on any of its rows, and several as the glyph and +N with a compact tree", () => {
    const newest = thread("newest", 30);
    const older = thread("older", 10);
    const { draw } = setup([older, newest], { older: [link(40, { state: "merged" })], newest: [link(41, { state: "merged" }), link(42, { state: "closed" })] });
    draw(older);
    const single = screen.getByRole("link", { name: "PR #40 merged, linked" });
    expect(single.textContent).toBe("40");
    expect(single.classList.contains("state-merged")).toBe(true);
    cleanup();
    draw(newest);
    const several = screen.getByRole("button", { name: /^3 requests, open: PR #35 open, PR #41 merged, PR #42 closed$/u });
    expect(several.textContent).toBe("+3");
    expect(several.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("shows a stack as the layers glyph and its size", () => {
    const newest = thread("newest", 30);
    const { draw } = setup([newest], { newest: [link(50, { stack: { number: 3, size: 6 } }), link(51, { stack: { number: 3, size: 6 } })] });
    draw(newest);
    const badge = screen.getByRole("button", { name: /^Stack of 6 requests, open: /u });
    expect(badge.textContent).toBe("6");
    expect(badge.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it.each(["Enter", " "])("activates the multi-request badge with %s without selecting its enclosing row", (key) => {
    const newest = thread("newest", 30);
    const rows = new RowRequests(async () => REQUEST);
    rows.set("/project", REQUEST);
    const links = new ThreadLinkRows({ links: async () => [link(41)], onLinksChanged: () => () => undefined });
    links.set(newest.id, [link(41)]);
    const Badge = createRequestBadge(rows, links);
    const clicked = vi.fn();
    const keydown = vi.fn();
    render(<TestThreadStore threads={[newest]}><button onKeyDown={keydown}><Badge session={newest} /></button></TestThreadStore>);
    const badge = screen.getByRole("button", { name: /^2 requests, open:/u });
    badge.addEventListener("click", clicked);
    expect(badge.tagName).toBe("SPAN");
    expect(badge.tabIndex).toBe(0);
    fireEvent.keyDown(badge, { key });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(keydown).not.toHaveBeenCalled();
  });

  it("reads several requests as the one most alive", () => {
    expect(aggregateState(["merged", "closed"])).toBe("merged");
    expect(aggregateState(["closed", "draft", "merged"])).toBe("draft");
    expect(aggregateState(["merged", "open"])).toBe("open");
    expect(aggregateState(["closed"])).toBe("closed");
  });

  it("opens a compact tree's request in Tau with a way back to its own thread overview", async () => {
    const newest = thread("newest", 30);
    const { draw } = setup([newest], { newest: [link(50, { title: "Base", headRef: "base", baseRef: "main" }), link(51, { title: "Child", headRef: "child", baseRef: "base" })] });
    const routes = { openStageTab: vi.fn(), openExternal: vi.fn() } as unknown as WorkbenchActions;
    const selectThread = vi.fn();
    draw(newest, routes, selectThread);
    const badge = screen.getByRole("button", { name: /^3 requests/u });
    badge.focus();
    fireEvent.keyDown(badge, { key: "ArrowDown" });
    const popup = await screen.findByRole("dialog", { name: "Thread pull requests" });
    const child = await within(popup).findByRole("listitem", { name: "PR #51, open: Child" });
    expect(child.parentElement!.parentElement!.querySelector(":scope > a")!.textContent).toContain("Base");
    expect(within(popup).queryAllByRole("link")).toHaveLength(3);
    expect(within(popup).queryAllByRole("button")).toHaveLength(0);
    expect(document.activeElement).toBe(badge);
    fireEvent.keyDown(badge, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread pull requests" })).toBeNull());
    expect(document.activeElement).toBe(badge);
    fireEvent.keyDown(badge, { key: "ArrowDown" });
    await screen.findByRole("dialog", { name: "Thread pull requests" });
    fireEvent.keyDown(badge, { key: "Enter" });
    expect(routes.openStageTab).toHaveBeenCalledWith(THREAD_PULL_REQUESTS_TAB, { threadId: "newest", workspace: "/project", branchUrl: REQUEST.url }, { key: "thread-pull-requests:newest" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread pull requests" })).toBeNull());
    fireEvent.keyDown(badge, { key: "ArrowDown" });
    const reopened = await screen.findByRole("dialog", { name: "Thread pull requests" });
    const request = await within(reopened).findByRole("link", { name: "PR #51, open: Child" });
    expect(request.getAttribute("href")).toBe(link(51).url);
    fireEvent.click(within(request).getByText("Child"));
    expect(routes.openStageTab).toHaveBeenLastCalledWith(PULL_REQUEST_TAB, expect.objectContaining({ url: link(51).url, workspace: "/project", fromThread: { threadId: "newest", workspace: "/project", branchUrl: REQUEST.url } }), { key: link(51).url });
    expect(routes.openExternal).not.toHaveBeenCalled();
    expect(selectThread).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread pull requests" })).toBeNull());
  });

  it.each(["metaKey", "ctrlKey"])("opens a popover request's website with %s without selecting its thread", async (modifier) => {
    const newest = thread("newest", 30);
    const { draw } = setup([newest], { newest: [link(50, { service: "gitlab", url: "https://gitlab.example.com/acme/tau/-/merge_requests/50", host: "gitlab.example.com", title: "Merge request" })] });
    const routes = { openStageTab: vi.fn(), openExternal: vi.fn() } as unknown as WorkbenchActions;
    const selectThread = vi.fn();
    draw(newest, routes, selectThread);
    fireEvent.keyDown(screen.getByRole("button", { name: /^2 requests/u }), { key: "ArrowDown" });
    const popup = await screen.findByRole("dialog", { name: "Thread pull requests" });
    const request = await within(popup).findByRole("link", { name: "MR !50, open: Merge request" });
    expect(within(request).getByText("!50")).toBeTruthy();
    fireEvent.click(request, { [modifier]: true });
    expect(routes.openExternal).toHaveBeenCalledWith("https://gitlab.example.com/acme/tau/-/merge_requests/50");
    expect(routes.openStageTab).not.toHaveBeenCalled();
    expect(selectThread).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread pull requests" })).toBeNull());
  });

  it("opens the compact tree when the pointer rests on the badge", async () => {
    const newest = thread("newest", 30);
    const { draw } = setup([newest], { newest: [link(50)] });
    draw(newest);
    const badge = screen.getByRole("button", { name: /^2 requests/u });
    fireEvent.pointerEnter(badge, { pointerType: "mouse" });
    const popup = await screen.findByRole("dialog", { name: "Thread pull requests" });
    await within(popup).findByRole("listitem", { name: "PR #50, open" });
    fireEvent.pointerLeave(badge, { pointerType: "mouse" });
    fireEvent.pointerEnter(popup.firstElementChild!, { pointerType: "mouse" });
    fireEvent.pointerLeave(popup.firstElementChild!, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread pull requests" })).toBeNull());
  });
});

describe("a thread's requests on its hover card", () => {
  function Row({ icon, children, label, onClick, onAuxClick }: { icon: ReactNode; children: ReactNode; label?: string; onClick?(event: import("react").MouseEvent<HTMLButtonElement>): void; onAuxClick?(event: import("react").MouseEvent<HTMLButtonElement>): void }) {
    return <button type="button" aria-label={label} onClick={onClick} onAuxClick={onAuxClick}>{icon}{children}</button>;
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

  it("lists linked requests newest first, and the unlinked branch request after them, each with its state", () => {
    const newest = thread("newest", 30);
    drawCard(newest, [newest], { newest: [link(12, { state: "merged", title: "Older fix" }), link(41, { state: "closed", title: "Dropped" }), link(40, { draft: true, title: "Draft work" })] });
    const lines = screen.getAllByRole("listitem");
    expect(lines.map((line) => line.textContent)).toEqual(["#41 Dropped", "#40 Draft work", "#12 Older fix", "#35 Rail badges"]);
    expect(lines.map((line) => line.className.replace("request-card-line ", ""))).toEqual(["state-closed", "state-draft", "state-merged", "state-open"]);
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

  it("opens the hover card request in the browser on a middle click", () => {
    const newest = thread("newest", 30);
    const { openStageTab, openExternal } = drawCard(newest, [newest], {});
    fireEvent(screen.getByRole("button", { name: "PR #35, open: Rail badges" }), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
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

});
