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

afterEach(cleanup);

const rows = parseGitHubList(readFileSync(join(import.meta.dirname, "fixtures", "gh-pr-list.json"), "utf8"), "BagToad");

function listClient(answer: (input: Parameters<PullRequestClient["list"]>[0]) => PullRequestList): PullRequestClient {
  return { list: vi.fn(async (input) => answer(input)) } as unknown as PullRequestClient;
}

const handle = (): StageTabHandle => ({ id: "ext:review.pull-requests", setTitle: vi.fn(), setDirty: vi.fn(), onClose: () => () => undefined });
const actions = () => ({ openExternal: vi.fn(), notify: vi.fn() }) as unknown as WorkbenchActions;

describe("the Pull Requests page", () => {
  it("groups the viewer's own work first, sorts, filters by typed qualifiers and opens a row", async () => {
    const client = listClient((input) => ({ service: "github", host: "github.com", repo: "cli/cli", viewer: "BagToad", entries: rows.filter((row) => input.state === "all" || row.state === input.state), truncated: false, limit: input.limit }));
    const open = vi.fn();
    const tab = handle();
    render(<PullRequestListView params={{ workspace: "/project" }} handle={tab} actions={actions()} client={client} open={open} />);
    const authored = await screen.findByRole("region", { name: "Authored" });
    expect(within(authored).getAllByRole("button").map((row) => row.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^#14475 /u)]);
    expect(within(screen.getByRole("region", { name: "Others" })).getAllByRole("button")).toHaveLength(3);
    expect(client.list).toHaveBeenCalledWith({ workspace: "/project", state: "open", limit: 100 });
    expect(tab.setTitle).toHaveBeenCalledWith("PRs · cli");

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
