// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageTabHandle, UiFileDiff, WorkbenchActions } from "tau";
import { readLinkInput } from "./link-dialog.js";
import type { PullRequestList, ThreadPullRequestLink } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { hideWhitespace } from "./pull-request-diff.js";
import { parseGitHubList } from "./pull-request-list-json.js";
import { PullRequestListView } from "./pull-request-list-view.js";
import { ThreadLinkRows } from "./thread-links-store.js";
import { TestPageActionSlot, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { LinkWatcher, worthShowing } from "./proactive-panels.js";

afterEach(cleanup);

const rows = parseGitHubList(readFileSync(join(import.meta.dirname, "fixtures", "gh-pr-list.json"), "utf8"), "BagToad");

function listClient(answer: (input: Parameters<PullRequestClient["list"]>[0]) => PullRequestList): PullRequestClient {
  return { list: vi.fn(async (input) => answer(input)) } as unknown as PullRequestClient;
}

const handle = (): StageTabHandle => ({ id: "ext:review.pull-requests", setTitle: vi.fn(), setDirty: vi.fn(), onClose: () => () => undefined });
const actions = () => ({ openExternal: vi.fn(), notify: vi.fn() }) as unknown as WorkbenchActions;

describe("the Pull Requests page", () => {
  it("keeps a thread's tab to its project and leads to Reviews' Remote tab for the rest", async () => {
    const client = listClient(() => ({ service: "github", host: "github.com", repo: "cli/cli", entries: rows.slice(0, 1), truncated: false, limit: 100 }));
    const openPage = vi.fn();
    render(<PullRequestListView params={{ workspace: "/project" }} handle={handle()} actions={{ ...actions(), openPage } as unknown as WorkbenchActions} client={client} open={vi.fn()} />);
    await screen.findByRole("button", { name: /^#/u });
    expect(screen.queryByRole("button", { name: /^Projects:/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filter pull requests" }));
    expect(screen.queryByRole("menuitem", { name: /Project/u })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(openPage).toHaveBeenCalledWith("review.reviews", { tab: "remote" });
  });


  it("puts Refresh in the page head while the list is on screen", async () => {
    const client = { listMany: vi.fn(async () => ({ lists: [], failures: [] })) } as unknown as PullRequestClient;
    const slot = document.createElement("div");
    document.body.append(slot);
    const page = (headAction: boolean) => (
      <TestThreadStore threads={[]} projects={[{ path: "/cli", workspaceId: "/cli", name: "cli", lastOpenedAt: 1 }]}>
        <TestPageActionSlot slot={slot}>
          <PullRequestListView surface="page" headAction={headAction} params={{ scope: "all" }} actions={actions()} client={client} open={vi.fn()} />
        </TestPageActionSlot>
      </TestThreadStore>
    );
    const { rerender } = render(page(true));
    await waitFor(() => expect(client.listMany).toHaveBeenCalled());
    expect(within(slot).getByRole("button", { name: "Refresh pull requests" })).toBeTruthy();
    expect(within(screen.getByLabelText("Pull requests")).queryByRole("button", { name: "Refresh pull requests" })).toBeNull();
    // A request's view covers the list: Refresh goes back into the hidden list.
    rerender(page(false));
    expect(within(slot).queryByRole("button")).toBeNull();
    expect(within(screen.getByLabelText("Pull requests")).getByRole("button", { name: "Refresh pull requests" })).toBeTruthy();
    slot.remove();
  });

  it("lists every project across hosts, each row with its repository and its host's own viewer", async () => {
    const gitlab = { ...rows[0]!, ref: { ...rows[0]!.ref, service: "gitlab" as const, host: "gitlab.com", repo: "acme/tools", number: 3, url: "https://gitlab.com/acme/tools/-/merge_requests/3" }, author: { login: "mona" }, stack: { number: 9, size: 3, position: 2 } };
    const client = {
      list: vi.fn(async () => { throw new Error("not in this test"); }),
      listMany: vi.fn(async () => ({
        lists: [
          { service: "github" as const, host: "github.com", repo: "cli/cli", viewer: "BagToad", entries: rows.slice(0, 2), truncated: false, limit: 100, workspaces: ["/cli"] },
          { service: "gitlab" as const, host: "gitlab.com", repo: "acme/tools", viewer: "mona", entries: [gitlab], truncated: false, limit: 100, workspaces: ["/tools"] },
        ],
        failures: [{ workspace: "/scratch", message: "This project has no remote, so it has no pull requests to list." }],
      })),
    } as unknown as PullRequestClient;
    const open = vi.fn();
    const projects = [
      { path: "/cli", workspaceId: "/cli", name: "cli", lastOpenedAt: 1 },
      { path: "/tools", workspaceId: "/tools", name: "tools", lastOpenedAt: 2 },
      { path: "/scratch", workspaceId: "/scratch", name: "scratch", lastOpenedAt: 3 },
    ];
    render(<TestThreadStore threads={[]} projects={projects}><PullRequestListView surface="page" params={{ scope: "all" }} actions={actions()} client={client} open={open} /></TestThreadStore>);
    const authored = await screen.findByRole("region", { name: "Authored" });
    expect(client.listMany).toHaveBeenCalledWith({ workspaces: ["/cli", "/tools", "/scratch"], state: "open", limit: 100 });
    // mona is the viewer on GitLab, so her request counts as her own.
    expect(within(authored).getAllByRole("button").map((row) => row.getAttribute("aria-label"))).toContain("#3 " + gitlab.title);
    expect(screen.getByRole("button", { name: "Projects: All projects" }).textContent).toContain("All projects · 2 repositories");
    expect(screen.getByText("acme/tools")).toBeTruthy();
    expect(screen.getByLabelText("Stack layer 2 of 3")).toBeTruthy();
    expect(screen.getByText("Not listed: scratch.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^#3 /u }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ref: expect.objectContaining({ number: 3 }) }), "/tools");

    // Grouped by project in the order of their first row, each named as the project list names it.
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Group by" })).getByRole("radio", { name: "Project" }));
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["tools", "cli"]);

    fireEvent.click(screen.getByRole("button", { name: "Filter pull requests" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Host/u }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "gitlab.com" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^#14485 /u })).toBeNull());
    expect(screen.getByRole("button", { name: /^#3 /u })).toBeTruthy();
  });


  it("groups the viewer's own work first, sorts, filters by typed qualifiers and opens a row", async () => {
    const client = listClient((input) => ({ service: "github", host: "github.com", repo: "cli/cli", viewer: "BagToad", entries: rows.filter((row) => input.state === "all" || row.state === input.state), truncated: false, limit: input.limit }));
    const open = vi.fn();
    const tab = handle();
    render(<PullRequestListView params={{ workspace: "/project" }} handle={tab} actions={actions()} client={client} open={open} />);
    const authored = await screen.findByRole("region", { name: "Authored" });
    expect(within(authored).getAllByRole("button").map((row) => row.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^#14475 /u)]);
    expect(within(screen.getByRole("region", { name: "Others" })).getAllByRole("button")).toHaveLength(3);
    expect(client.list).toHaveBeenCalledWith({ workspace: "/project", state: "open", limit: 100 });
    await waitFor(() => expect(tab.setTitle).toHaveBeenCalledWith("PRs · cli"));

    fireEvent.click(screen.getByRole("button", { name: "Sort pull requests" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Blocked on me/u }));
    expect(screen.getByRole("button", { name: "Sort pull requests" }).textContent).toContain("Blocked on me");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search pull requests" }), { target: { value: "label:blocked" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Authored" })).toBeNull());
    const shown = screen.getAllByRole("button", { name: /^#\d+ /u });
    expect(shown.map((row) => row.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^#14474 /u)]);
    fireEvent.click(shown[0]!);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ref: expect.objectContaining({ number: 14474 }) }), "/project");

    fireEvent.click(screen.getByRole("radio", { name: "Merged" }));
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith({ workspace: "/project", state: "merged", limit: 100 }));
  });

  it("loads more rows of the same question, and says when the host cannot be read", async () => {
    let fail = false;
    const client = listClient((input) => {
      if (fail) throw new Error("GitHub CLI (gh) is not signed in.");
      return { service: "github", host: "github.com", repo: "cli/cli", entries: rows.slice(0, input.limit === 100 ? 2 : 4), truncated: input.limit === 100, limit: input.limit };
    });
    render(<PullRequestListView params={{}} handle={handle()} actions={actions()} client={client} open={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more pull requests" }));
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith({ state: "open", limit: 200 }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^#\d+ /u })).toHaveLength(4));
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not signed in");
  });
});

describe("linking", () => {
  it("reads what the dialog's input names", () => {
    expect(readLinkInput("")).toBeUndefined();
    expect(readLinkInput("#12")).toEqual({ kind: "number", label: "#12 in this thread's repository" });
    expect(readLinkInput("https://gitlab.com/g/p/-/merge_requests/3")).toEqual({ kind: "url", label: "gitlab.com/g/p #3" });
    expect(readLinkInput("https://github.com/o/r/issues/3")).toEqual({ kind: "invalid" });
    expect(readLinkInput("#0")).toEqual({ kind: "invalid" });
  });

  it("reloads a thread's links when the host says they changed", async () => {
    const link: ThreadPullRequestLink = { url: "https://github.com/o/r/pull/1", service: "github", host: "github.com", repo: "o/r", number: 1, source: "agent", linkedAt: 1 };
    let changed: ((threadId: string) => void) | undefined;
    let answer: ThreadPullRequestLink[] = [];
    const store = new ThreadLinkRows({ links: vi.fn(async () => answer), onLinksChanged: (listener) => { changed = listener; return () => undefined; } });
    store.ensure("t1");
    await waitFor(() => expect(store.get("t1")).toEqual([]));
    answer = [link];
    changed!("t1");
    await waitFor(() => expect(store.get("t1")).toEqual([link]));
  });
});

describe("hiding whitespace", () => {
  const diff = (lines: UiFileDiff["hunks"][number]["lines"]): UiFileDiff => ({
    path: "a.ts",
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    hunks: [{ header: "@@ -1,3 +1,3 @@", lines }],
  });

  it("turns lines that changed only in whitespace into context and keeps real changes", () => {
    const hidden = hideWhitespace(diff([
      { kind: "removed", oldLine: 1, text: "if (a) {" },
      { kind: "removed", oldLine: 2, text: "  call(a)" },
      { kind: "added", newLine: 1, text: "if (a)  {" },
      { kind: "added", newLine: 2, text: "    call(a)" },
      { kind: "added", newLine: 3, text: "    other()" },
    ]));
    expect(hidden.hunks[0]!.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "if (a)  {" },
      { kind: "context", oldLine: 2, newLine: 2, text: "    call(a)" },
      { kind: "added", newLine: 3, text: "    other()" },
    ]);
    expect([hidden.added, hidden.removed]).toEqual([1, 0]);
  });

  it("says so when every change was whitespace, and leaves a real diff alone", () => {
    expect(hideWhitespace(diff([{ kind: "removed", oldLine: 1, text: "a\t" }, { kind: "added", newLine: 1, text: "a" }])).note).toBe("Only whitespace changed in this file.");
    const real = diff([{ kind: "removed", oldLine: 1, text: "a" }, { kind: "added", newLine: 1, text: "b" }]);
    expect(hideWhitespace(real)).toBe(real);
  });
});

describe("proactive panels", () => {
  it("opens the diff for a turn of at least 3 files or 50 lines", () => {
    const file = (added: number, removed = 0) => ({ path: `f${added}`, name: `f${added}`, directory: "", status: "modified" as const, added, removed });
    expect(worthShowing({ files: [file(1), file(1)], added: 2, removed: 0 })).toBe(false);
    expect(worthShowing({ files: [file(1), file(1), file(1)], added: 3, removed: 0 })).toBe(true);
    expect(worthShowing({ files: [file(30, 20)], added: 30, removed: 20 })).toBe(true);
  });

  it("counts a request as new only after the first look at its thread", () => {
    const watcher = new LinkWatcher();
    expect(watcher.observe("t1", ["a"])).toEqual([]);
    expect(watcher.observe("t1", ["a", "b"])).toEqual(["b"]);
    expect(watcher.observe("t1", ["b"])).toEqual([]);
    expect(watcher.observe("t2", ["c"])).toEqual([]);
  });
});
