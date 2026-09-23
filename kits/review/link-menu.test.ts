import { describe, expect, it, vi } from "vitest";
import type { PaletteSearchContext, WorkbenchActions } from "tau";
import { linkPullRequestMenu } from "./link-menu.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestListEntry } from "./protocol.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

const entry = (number: number, title: string): PullRequestListEntry => ({
  ref: { service: "github", host: "github.com", repo: "acme/demo", number, url: `https://github.com/acme/demo/pull/${number}` },
  title, author: { login: "tb" }, headRef: `topic-${number}`, baseRef: "main", state: "open", draft: false,
  additions: 0, deletions: 0, createdAt: "", updatedAt: "", labels: [], reviewRequested: false,
});

function setup(thread: ReturnType<WorkbenchActions["activeThread"]> = { sessionId: "t1", cwd: "/repo", workspaceId: "ws-1", draftPending: false }) {
  const client = {
    list: vi.fn(async () => ({ service: "github", host: "github.com", repo: "acme/demo", entries: [entry(12, "Fix the rail"), entry(14, "Add stacks")], truncated: false, limit: 50 })),
    link: vi.fn(async (_thread: string, reference: string) => ({ link: { number: Number(/\d+$/u.exec(reference)?.[0]) }, alreadyLinked: false })),
  } as unknown as PullRequestClient & { list: ReturnType<typeof vi.fn>; link: ReturnType<typeof vi.fn> };
  const rows = { load: vi.fn(async () => undefined) } as unknown as ThreadLinkRows;
  const actions = { activeThread: () => thread, notify: vi.fn() } as unknown as WorkbenchActions;
  const search = { actions, index: { projects: [], threads: [] }, signal: new AbortController().signal } as PaletteSearchContext;
  let clock = 0;
  const menu = linkPullRequestMenu(client, rows, () => clock);
  return { client, rows, actions, search, menu, advance: (ms: number) => { clock += ms; } };
}

describe("the link-pull-request level", () => {
  it("lists the project's open requests once a minute and links the one picked to the thread on screen", async () => {
    const { client, rows, actions, search, menu, advance } = setup();
    const items = await menu.items("", search);
    await menu.items("rail", search);
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenCalledWith({ workspace: "ws-1", state: "open", limit: 50 });
    expect(items.map((item) => item.label)).toEqual(["#12 Fix the rail", "#14 Add stacks"]);
    await items[1]!.run!(actions);
    expect(client.link).toHaveBeenCalledWith("t1", "https://github.com/acme/demo/pull/14", "/repo");
    expect(rows.load).toHaveBeenCalledWith("t1");
    expect(actions.notify).toHaveBeenCalledWith("Linked #14 to this thread.");
    advance(61_000);
    await menu.items("", search);
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("offers what is typed as a link of its own, first, and still when the list cannot be read", async () => {
    const { client, actions, search, menu } = setup();
    const url = "https://github.com/other/repo/pull/7";
    const items = await menu.items(url, search);
    expect(items[0]).toMatchObject({ label: "Link github.com/other/repo #7", keywords: [url] });
    await items[0]!.run!(actions);
    expect(client.link).toHaveBeenCalledWith("t1", url, "/repo");

    const fresh = setup();
    fresh.client.list.mockRejectedValue(new Error("gh is not signed in."));
    expect((await fresh.menu.items("#9", fresh.search)).map((item) => item.label)).toEqual(["Link #9 in this thread's repository"]);
    await expect(fresh.menu.items("", fresh.search)).rejects.toThrow("gh is not signed in. Paste a pull request URL or enter #123.");
  });

  it("says a thread is needed when a draft or nothing is on screen", async () => {
    const { menu, search } = setup({ draftPending: false });
    await expect(menu.items("", search)).rejects.toThrow("Open a thread first");
  });
});
