// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { parseGitHubDetail } from "./pull-request-json.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PullRequestDetail, ThreadPullRequestLink } from "./protocol.js";
import { PULL_REQUEST_TAB } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { ThreadLinkRows } from "./thread-links-store.js";
import ThreadPullRequests from "./thread-pull-requests.js";

afterEach(cleanup);
const link = (number: number, headRef: string, baseRef: string): ThreadPullRequestLink => ({ url: `https://github.com/acme/app/pull/${number}`, number, service: "github", host: "github.com", repo: "acme/app", source: "agent", linkedAt: number, title: `Change ${number}`, state: "open", headRef, baseRef });
const detail = parseGitHubDetail({ service: "github", host: "github.com", repo: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1" }, readFileSync(join(import.meta.dirname, "fixtures/gh-pr-view-discussed.json"), "utf8"));

function setup(requests: ThreadPullRequestLink[], view: PullRequestClient["view"] = vi.fn(async (url: string) => {
  const request = requests.find((entry) => entry.url === url)!;
  return { ...detail, ref: { ...detail.ref, url, number: request.number }, title: request.title!, state: request.state!, headRef: request.headRef, baseRef: request.baseRef! };
})) {
  let current = requests;
  const linksRead = vi.fn(async () => current);
  const links = new ThreadLinkRows({ links: linksRead, onLinksChanged: () => () => undefined });
  const client = { view } as unknown as PullRequestClient;
  const actions = { openStageTab: vi.fn(), openExternal: vi.fn() } as unknown as WorkbenchActions;
  const draw = (threadId = "t1", branchUrl?: string) => <TestThreadStore threads={[]}><ThreadPullRequests params={{ threadId, workspace: "/work", ...(branchUrl ? { branchUrl } : {}) }} actions={actions} client={client} links={links} /></TestThreadStore>;
  const rendered = render(draw());
  return { actions, links, linksRead, view, draw, ...rendered, change: (next: ThreadPullRequestLink[]) => { current = next; act(() => links.set("t1", next)); } };
}

it("shows only the thread's links as nested rows and opens requests or their checks", async () => {
  const base = link(1, "buttons", "main");
  const child = link(2, "cards", "buttons");
  const { actions, linksRead } = setup([child, base]);
  const row = await screen.findByRole("button", { name: "PR #2 Change 2" });
  expect(row.closest("li")!.parentElement!.parentElement!.querySelector(":scope > .thread-pr-row")!.textContent).toContain("Change 1");
  expect(screen.getByLabelText("2 requests in this branch stack")).toBeTruthy();
  await within(row).findByText(detail.author!.login);
  expect(within(row).getByText("cards → buttons")).toBeTruthy();
  expect(linksRead).toHaveBeenCalledWith("t1", undefined);
  fireEvent.click(row);
  expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, expect.objectContaining({ url: child.url, workspace: "/work", fromThread: { threadId: "t1", workspace: "/work", scrollTop: 0 } }), { key: child.url });
  fireEvent.click(await screen.findByRole("button", { name: /^Checks for PR #2:/u }));
  expect(actions.openStageTab).toHaveBeenLastCalledWith(PULL_REQUEST_TAB, expect.objectContaining({ url: child.url, focus: "checks" }), { key: child.url });
  for (const modifier of ["metaKey", "ctrlKey"]) {
    fireEvent.click(row, { [modifier]: true });
    expect(actions.openExternal).toHaveBeenLastCalledWith(child.url);
  }
});

it("retains saved links when a provider fails and updates the list when links change", async () => {
  const failing = vi.fn(async () => { throw new Error("offline"); });
  const { change } = setup([link(1, "buttons", "main")], failing);
  await screen.findByText("Some request details could not be loaded. Showing saved links.");
  expect(screen.getByRole("button", { name: "PR #1 Change 1" })).toBeTruthy();
  change([link(2, "cards", "main")]);
  await screen.findByRole("button", { name: "PR #2 Change 2" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "PR #1 Change 1" })).toBeNull());
});

it("writes GitLab merge request numbers with their provider's sign in rows and checks", async () => {
  setup([{ ...link(1, "buttons", "main"), service: "gitlab", host: "gitlab.example.com", url: "https://gitlab.example.com/acme/app/-/merge_requests/1" }]);
  const row = await screen.findByRole("button", { name: "MR !1 Change 1" });
  expect(within(row).getByText("!1")).toBeTruthy();
  expect(await screen.findByRole("button", { name: /^Checks for MR !1:/u })).toBeTruthy();
});

it("refreshes the thread's links through the force path and handles an empty thread", async () => {
  const { linksRead } = setup([]);
  await screen.findByText("No linked pull requests");
  fireEvent.click(screen.getByRole("button", { name: "Refresh thread pull requests" }));
  await waitFor(() => expect(linksRead).toHaveBeenCalledWith("t1", "force"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh thread pull requests" }) as HTMLButtonElement).disabled).toBe(false));
});

it("includes the badge's branch request once even before it is linked", async () => {
  const request = link(1, "buttons", "main");
  const read = vi.fn(async () => ({ ...detail, ref: { ...detail.ref, url: request.url }, title: "Branch request" }));
  const { rerender, draw, change } = setup([], read);
  rerender(draw("t1", request.url));
  await screen.findByRole("button", { name: "PR #1 Branch request" });
  change([request]);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "PR #1 Branch request" })).toHaveLength(1));
});

it("reads at most four details at once and stops starting reads when the tab closes", async () => {
  const waiting = new Map<string, (detail: PullRequestDetail) => void>();
  const read = vi.fn((url: string) => new Promise<PullRequestDetail>((resolve) => { waiting.set(url, resolve); }));
  const requests = Array.from({ length: 8 }, (_, index) => link(index + 1, `branch-${index}`, "main"));
  const { unmount } = setup(requests, read);
  await screen.findByRole("button", { name: "PR #8 Change 8" });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  await act(async () => { waiting.get(requests[0]!.url)!({ ...detail, ref: { ...detail.ref, url: requests[0]!.url } }); });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(5));
  unmount();
  await act(async () => { for (const resolve of waiting.values()) resolve(detail); });
  expect(read).toHaveBeenCalledTimes(5);
});

it("keeps a watch's merged link settled when the cached detail still says open", async () => {
  const request = { ...link(1, "buttons", "main"), state: "merged" as const };
  setup([request], async () => ({ ...detail, title: "Cached open request", state: "open" }));
  const row = await screen.findByRole("button", { name: "PR #1 Cached open request" });
  expect(within(row).getByRole("img", { name: "Merged" })).toBeTruthy();
});
