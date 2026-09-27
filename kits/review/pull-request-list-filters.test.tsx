// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseGitHubList } from "./pull-request-list-json.js";
import { listNarrowings } from "./pull-request-list-filters.js";
import { PullRequestListView } from "./pull-request-list-view.js";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";

const rows = parseGitHubList(readFileSync(join(import.meta.dirname, "fixtures", "gh-pr-list.json"), "utf8"), "BagToad");
const projects = [
  { path: "/cli", workspaceId: "/cli", name: "cli", lastOpenedAt: 1 },
  { path: "/tools", workspaceId: "/tools", name: "tools", lastOpenedAt: 2 },
];

describe("what narrows the list", () => {
  it("names every restriction away from the defaults, in the sheet's order", () => {
    const defaults = { state: "open" as const, involvement: "all" as const, labels: [] };
    expect(listNarrowings(defaults)).toEqual([]);
    expect(listNarrowings({ ...defaults, project: "cli", state: "all", involvement: "reviewing", draft: "hide", review: "approved", checks: "failing", labels: ["bug", "go"], author: "mona", host: "gitlab.com" }).map((item) => [item.id, item.label])).toEqual([
      ["project", "cli"],
      ["state", "Any state"],
      ["involvement", "Reviewing"],
      ["draft", "No drafts"],
      ["review", "Approved"],
      ["checks", "Checks failing"],
      ["label:bug", "bug"],
      ["label:go", "go"],
      ["author", "@mona"],
      ["host", "gitlab.com"],
    ]);
  });
});

describe("the Pull Requests page on a phone", () => {
  beforeEach(() => { document.body.dataset.profile = "compact"; });
  afterEach(() => { cleanup(); delete document.body.dataset.profile; });

  function renderPage() {
    const client = {
      listMany: vi.fn(async (input: { state: string }) => ({
        lists: [
          { service: "github" as const, host: "github.com", repo: "cli/cli", viewer: "BagToad", entries: rows.filter((row) => input.state === "all" || row.state === input.state), truncated: false, limit: 100, workspaces: ["/cli"] },
          { service: "github" as const, host: "github.com", repo: "acme/tools", viewer: "BagToad", entries: [], truncated: false, limit: 100, workspaces: ["/tools"] },
        ],
        failures: [],
      })),
      list: vi.fn(async (input: { state: string }) => ({ service: "github" as const, host: "github.com", repo: "cli/cli", viewer: "BagToad", entries: rows.filter((row) => input.state === "all" || row.state === input.state), truncated: false, limit: 100 })),
    } as unknown as PullRequestClient;
    const actions = { openExternal: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions;
    render(<TestThreadStore threads={[]} projects={projects}><PullRequestListView surface="page" params={{ scope: "all" }} actions={actions} client={client} open={vi.fn()} /></TestThreadStore>);
    return client;
  }

  it("keeps the header to one line and moves project, state, involvement, grouping, sort and filters into a sheet", async () => {
    const client = renderPage();
    await screen.findByRole("button", { name: /^#14474 /u });
    const header = screen.getByRole("searchbox", { name: "Search pull requests" }).closest("header")!;
    expect(within(header).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Filter pull requests", "Refresh pull requests"]);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    expect(screen.getByText(/of \d+ · Merge readiness$/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Filter pull requests" }));
    const sheet = await screen.findByRole("dialog", { name: "Filter pull requests" });
    for (const legend of ["State", "Involvement", "Group by", "Drafts", "Review", "Checks", "Labels"]) expect(within(sheet).getByRole("group", { name: legend })).toBeTruthy();
    for (const list of ["Project", "Sort", "Author"]) expect(within(sheet).getByRole("combobox", { name: list })).toBeTruthy();
    expect(within(sheet).getByRole("status").textContent).toMatch(/pull requests shown$/u);

    fireEvent.click(within(sheet).getByRole("checkbox", { name: /^go/u }));
    fireEvent.click(within(sheet).getByRole("radio", { name: "Closed" }));
    await waitFor(() => expect(client.listMany).toHaveBeenLastCalledWith(expect.objectContaining({ state: "closed" })));
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Project" }), { target: { value: "project:/cli" } });
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: "/cli", state: "closed" })));

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter pull requests" })).toBeNull());
    expect(screen.getByRole("button", { name: "Filter pull requests, 3 active" })).toBeTruthy();
    const chips = screen.getByRole("group", { name: "Active filters" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["cli", "Closed", "go", "Clear all"]);

    fireEvent.click(within(chips).getByRole("button", { name: "Remove filter: Closed" }));
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: "/cli", state: "open" })));
    expect(screen.getByRole("button", { name: "Filter pull requests, 2 active" })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("group", { name: "Active filters" })).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull());
    expect(screen.getByRole("button", { name: "Filter pull requests" })).toBeTruthy();
    await waitFor(() => expect(client.listMany).toHaveBeenLastCalledWith(expect.objectContaining({ state: "open" })));
  });
});
