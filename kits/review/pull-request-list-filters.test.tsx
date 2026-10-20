// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { PullRequestCache, OFFLINE_REASON } from "./pull-request-cache.js";
import { pullRequestClient } from "./pull-request-client.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseGitHubList } from "./pull-request-list-json.js";
import { listNarrowings } from "./pull-request-list-filters.js";
import { PullRequestListView } from "./pull-request-list-view.js";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";

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
      ["site", "gitlab.com"],
    ]);
  });
});

describe("the Pull Requests page on a phone", () => {
  let storage: ReturnType<typeof createMemoryStorage>;
  beforeEach(() => { document.body.dataset.profile = "compact"; storage = createMemoryStorage(); setClientStorage(storage); });
  afterEach(() => { cleanup(); delete document.body.dataset.profile; setClientStorage(undefined); });

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

  it("keeps the project, labels and author across a restart", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^#14474 /u });
    fireEvent.click(screen.getByRole("button", { name: "Filter pull requests" }));
    const sheet = await screen.findByRole("dialog", { name: "Filter pull requests" });
    fireEvent.click(within(sheet).getByRole("checkbox", { name: /^go/u }));
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Author" }), { target: { value: "author:BagToad" } });
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Project" }), { target: { value: "project:/cli" } });
    await waitFor(() => expect(JSON.parse(storage.get("tau.review.pull-requests.narrowing")!)).toEqual({ project: "/cli", labels: ["go"], author: "BagToad" }));

    cleanup();
    const client = renderPage();
    await waitFor(() => expect(client.list).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/cli" })));
    expect(client.listMany).not.toHaveBeenCalled();
    const chips = await screen.findByRole("group", { name: "Active filters" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["cli", "go", "@BagToad", "Clear all"]);
  });

  it("falls back to every project when the saved one is gone, and drops a cleared filter", async () => {
    storage.set("tau.review.pull-requests.narrowing", JSON.stringify({ project: "/gone", labels: ["go"], host: "github.com" }));
    const client = renderPage();
    await waitFor(() => expect(client.listMany).toHaveBeenCalled());
    expect(client.list).not.toHaveBeenCalled();
    const chips = await screen.findByRole("group", { name: "Active filters" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["go", "github.com", "Clear all"]);

    fireEvent.click(within(chips).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(storage.get("tau.review.pull-requests.narrowing")).toBe("{}"));
  });

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


describe("saved request lists", () => {
  afterEach(cleanup);
  it("shows the saved list before RPC, reads it offline and replaces it on reconnect", async () => {
    const cache = new PullRequestCache(createMemoryStorage());
    const listing = { service: "github" as const, host: "github.com", repo: "cli/cli", viewer: "BagToad", entries: rows, truncated: false, limit: 100 };
    const invoke = vi.fn(async () => listing);
    const client = pullRequestClient({ invoke, onEvent: () => () => undefined }, cache);
    await client.list({ workspace: "/cli", state: "open", limit: 100 });
    let finish!: (value: typeof listing) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<TestThreadStore threads={[]} projects={projects}><PullRequestListView params={{ workspace: "/cli" }} actions={{ notify: vi.fn() } as unknown as WorkbenchActions} client={client} open={vi.fn()} /></TestThreadStore>);
    await screen.findByRole("button", { name: /^#14474 /u });
    expect((await screen.findByText(/As of/)).textContent).toContain("Saved on this device");
    await act(async () => { finish(listing); });
    act(() => cache.setConnected(false));
    await screen.findByText(new RegExp(OFFLINE_REASON.replaceAll(".", "\\.")));
    invoke.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull requests" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh pull requests" }) as HTMLButtonElement).disabled).toBe(false));
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ ...listing, entries: [{ ...rows[0]!, title: "Updated list entry" }] });
    act(() => cache.setConnected(true));
    await screen.findByRole("button", { name: /Updated list entry/u });
    expect(screen.queryByText(new RegExp(OFFLINE_REASON.replaceAll(".", "\\.")))).toBeNull();
  });
});
