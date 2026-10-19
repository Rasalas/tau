// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandContribution, HostExtensionClient, RegionContribution, RegionProps, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { REVIEWS_PAGE } from "./local-reviews.js";
import { THREAD_PULL_REQUESTS_TAB, type PullRequestList, type PullRequestListEntry, type ThreadPullRequestLink } from "./protocol.js";
import { PullRequestWatchFeed } from "./pr-watch-client.js";
import type { PullRequestWatch } from "./pr-watch-protocol.js";
import { parseRequestUrl } from "./pull-request-json.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { registerThreadLinkSheet } from "./thread-link-sheets.js";
import { ThreadLinkRows } from "./thread-links-store.js";

afterEach(() => {
  cleanup();
  delete document.body.dataset.profile;
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
});

const url = (number: number) => `https://github.com/acme/app/pull/${number}`;
const link = (number: number, extra: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({ url: url(number), number, service: "github", host: "github.com", repo: "acme/app", source: "user", linkedAt: number, title: `Change ${number}`, state: "open", headRef: `branch-${number}`, ...extra });
const openEntry = (number: number): PullRequestListEntry => ({ ref: { ...parseRequestUrl(url(number))! }, title: `Open ${number}`, headRef: `open-${number}`, baseRef: "main", state: "open", draft: false, additions: 0, deletions: 0, createdAt: "", updatedAt: "", labels: [], reviewRequested: false, author: { login: "ada" } });
const watching = (number: number): PullRequestWatch => ({ threadId: "t1", ref: parseRequestUrl(url(number))!, status: "watching", wakes: 0, commentStreak: 0, startedAt: Date.now() });

function setup(options: { links?: ThreadPullRequestLink[]; open?: PullRequestListEntry[]; watches?: PullRequestWatch[]; compact?: boolean; readOnly?: boolean } = {}) {
  if (options.compact !== false) document.body.dataset.profile = "compact";
  let stored = options.links ?? [link(1), link(2, { state: "merged" })];
  const rows = new ThreadLinkRows({ links: async () => stored, onLinksChanged: () => () => undefined });
  rows.set("t1", stored);
  const client = {
    list: vi.fn(async () => ({ entries: options.open ?? [openEntry(3), openEntry(4)] }) as unknown as PullRequestList),
    link: vi.fn(async (_thread: string, reference: string) => { const next = link(Number(reference.split("/").pop() ?? 9)); stored = [...stored, next]; return { link: next, alreadyLinked: false }; }),
    unlink: vi.fn(async (_thread: string, target: string) => { stored = stored.filter((existing) => existing.url !== target); return true; }),
    links: async () => stored,
    onLinksChanged: () => () => undefined,
  } as unknown as PullRequestClient;
  let watches = options.watches ?? [];
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "watch-list") return { watches, canManage: true };
    const target = (input as { url: string }).url;
    watches = command === "watch-start" ? [...watches, watching(Number(target.split("/").pop()))] : watches.filter((watch) => watch.ref.url !== target);
    return undefined;
  });
  const feed = new PullRequestWatchFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient);
  let command: CommandContribution | undefined;
  let Layer: ComponentType<RegionProps> | undefined;
  const dispose = registerThreadLinkSheet({
    registerCommand: (value) => { command = value; return () => undefined; },
    registerRegion: (value: RegionContribution) => { Layer = value.Component; return () => undefined; },
  }, { client, links: rows, watches: feed });
  const actions = {
    activeThread: () => ({ sessionId: "t1", cwd: "/work" }),
    notify: vi.fn(),
    copyText: vi.fn(async () => undefined),
    openExternal: vi.fn(),
    openPage: vi.fn(),
    openStageTab: vi.fn(),
  } as unknown as WorkbenchActions;
  const view = render(<HostClientProvider client={createFakeHostClient({ isReadOnly: () => options.readOnly === true })}>{(() => { const Region = Layer!; return <Region actions={actions} />; })()}</HostClientProvider>);
  return { client, invoke, actions, command: command!, rows, dispose, openSheet: () => act(() => { void command!.run(actions); }), view };
}

const sheet = () => screen.findByRole("dialog", { name: "Pull requests" });
const rowActions = async (name: string) => {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("group", { name: `Actions for ${name}` });
};

it("is a thread-title command that lists the thread's linked requests with their state in a sheet", async () => {
  const { command, openSheet } = setup({ watches: [watching(1)] });
  expect(command.surfaces).toEqual(["thread-title"]);
  openSheet();
  const dialog = await sheet();
  expect(within(dialog).getByRole("button", { name: "Open PR #1 Change 1, open" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Open PR #2 Change 2, merged" })).toBeTruthy();
  await waitFor(() => expect(within(dialog).getByLabelText("Watching")).toBeTruthy());
  expect(within(dialog).getByRole("button", { name: "Link a pull request…" })).toBeTruthy();
});

it("opens the thread's overview tab instead on a desktop", () => {
  const { openSheet, actions } = setup({ compact: false });
  openSheet();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(actions.openStageTab).toHaveBeenCalledWith(THREAD_PULL_REQUESTS_TAB, { threadId: "t1", workspace: "/work" }, { key: "thread-pull-requests:t1" });
});

it("watches and stops watching a request from its row", async () => {
  const { invoke, openSheet } = setup();
  openSheet();
  await sheet();
  const group = await rowActions("PR #1");
  fireEvent.click(within(group).getByRole("button", { name: "Watch PR #1" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-start", { threadId: "t1", url: url(1) }));
  const stop = await within(group).findByRole("button", { name: "Stop watching PR #1" });
  await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(stop);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-stop", { threadId: "t1", url: url(1) }));
});

it("does not offer to watch a merged request", async () => {
  const { openSheet } = setup();
  openSheet();
  await sheet();
  const group = await rowActions("PR #2");
  expect((within(group).getByRole("button", { name: "Watch PR #2" }) as HTMLButtonElement).disabled).toBe(true);
});

it("unlinks a request and drops its row", async () => {
  const { client, openSheet } = setup();
  openSheet();
  await sheet();
  fireEvent.click(within(await rowActions("PR #1")).getByRole("button", { name: "Unlink PR #1" }));
  await waitFor(() => expect(client.unlink).toHaveBeenCalledWith("t1", url(1)));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Open PR #1 Change 1, open" })).toBeNull());
});

it("opens a request on the Reviews page and closes the sheet", async () => {
  const { actions, openSheet } = setup();
  openSheet();
  await sheet();
  fireEvent.click(within(await rowActions("PR #1")).getByRole("button", { name: "Open PR #1" }));
  expect(actions.openPage).toHaveBeenCalledWith(REVIEWS_PAGE, expect.objectContaining({ tab: "remote", url: url(1), workspace: "/work" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("copies the link, and shares it by the Web Share API when there is one, by copy and a toast when not", async () => {
  const { actions, openSheet } = setup();
  openSheet();
  await sheet();
  const group = await rowActions("PR #1");
  fireEvent.click(within(group).getByRole("button", { name: "Copy link to PR #1" }));
  await waitFor(() => expect(actions.copyText).toHaveBeenCalledWith(url(1)));
  const share = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "share", { value: share, configurable: true });
  fireEvent.click(within(group).getByRole("button", { name: "Share PR #1" }));
  await waitFor(() => expect(share).toHaveBeenCalledWith({ url: url(1), title: "PR #1 Change 1" }));
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  fireEvent.click(within(group).getByRole("button", { name: "Share PR #1" }));
  await waitFor(() => expect(actions.notify).toHaveBeenCalledWith("Sharing is not available here. Copied the link instead."));
  expect(actions.copyText).toHaveBeenCalledTimes(2);
});

it("links a request picked from the project's open requests, and one typed as a URL", async () => {
  const { client, actions, openSheet } = setup();
  openSheet();
  await sheet();
  fireEvent.click(screen.getByRole("button", { name: "Link a pull request…" }));
  await waitFor(() => expect(client.list).toHaveBeenCalledWith({ workspace: "/work", state: "open", limit: 50 }));
  fireEvent.click(await screen.findByRole("button", { name: "Link PR #3 Open 3" }));
  await waitFor(() => expect(client.link).toHaveBeenCalledWith("t1", url(3), "/work"));
  await waitFor(() => expect(actions.notify).toHaveBeenCalledWith("Linked #3 to this thread."));
  expect(await screen.findByRole("button", { name: "Open PR #3 Change 3, open" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Link a pull request…" }));
  const input = await screen.findByLabelText("Pull request URL or number");
  fireEvent.change(input, { target: { value: url(8) } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(client.link).toHaveBeenLastCalledWith("t1", url(8), "/work"));
});

it("marks a request that is already linked and filters the list as the person types", async () => {
  const { openSheet } = setup({ links: [link(3)] });
  openSheet();
  await sheet();
  fireEvent.click(screen.getByRole("button", { name: "Link a pull request…" }));
  const linked = await screen.findByRole("button", { name: "PR #3 Open 3, already linked" });
  expect((linked as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Pull request URL or number"), { target: { value: "open-4" } });
  expect(screen.queryByRole("button", { name: /Open 3/u })).toBeNull();
  expect(screen.getByRole("button", { name: "Link PR #4 Open 4" })).toBeTruthy();
});

it("disables linking and unlinking on a read-only device but still lists, opens and copies", async () => {
  const { openSheet } = setup({ readOnly: true });
  openSheet();
  await sheet();
  expect((screen.getByRole("button", { name: "Link a pull request…" }) as HTMLButtonElement).disabled).toBe(true);
  const group = await rowActions("PR #1");
  expect((within(group).getByRole("button", { name: "Unlink PR #1" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(group).getByRole("button", { name: "Copy link to PR #1" }) as HTMLButtonElement).disabled).toBe(false);
});
