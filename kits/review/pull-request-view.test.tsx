// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageTabHandle, UiReviewRequest, WorkbenchActions } from "tau";
import type { ComposerContextChips, PullRequestDetail, PullRequestFiles } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseGitHubDetail, parseGitHubThreads, parseRequestUrl, parseUnifiedDiff } from "./pull-request-json.js";
import { PullRequestView } from "./pull-request-view.js";
import { RowRequests } from "./requests.js";

afterEach(cleanup);

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const REF = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const PARAMS = { url: REF.url, number: 7, service: "github" as const, workspace: "/project" };

function fakeClient(overrides: Partial<PullRequestClient> = {}): PullRequestClient {
  const detail = parseGitHubDetail(REF, fixture("gh-pr-view-discussed.json"));
  const { threads, viewed } = parseGitHubThreads(fixture("gh-pr-threads-discussed.json"));
  const entries = parseUnifiedDiff(fixture("gh-pr-diff.patch"));
  const files: PullRequestFiles = {
    files: entries.map((entry) => ({ ...entry.file, viewed: viewed.get(entry.file.path) ?? "unviewed" })),
    diffs: entries.map((entry) => entry.diff),
    viewedOn: "host",
  };
  return {
    view: vi.fn(async () => detail),
    checks: vi.fn(async () => detail.checks),
    threads: vi.fn(async () => threads),
    files: vi.fn(async () => files),
    comment: vi.fn(async () => undefined),
    update: vi.fn(async (_url: string, input: { title?: string; body?: string }): Promise<PullRequestDetail> => ({ ...detail, ...(input.title ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}) })),
    viewed: vi.fn(async (_url: string, _path: string, value: boolean) => value ? "viewed" as const : "unviewed" as const),
    ...overrides,
  };
}

function actions(): WorkbenchActions {
  return {
    openExternal: vi.fn(),
    notify: vi.fn(),
    focusComposer: vi.fn(),
    composerDraft: () => "",
    copyText: vi.fn(async () => undefined),
  } as unknown as WorkbenchActions;
}

function handle(): StageTabHandle {
  return { id: "ext:review.pull-request:7", setTitle: vi.fn(), setDirty: vi.fn(), onClose: () => () => undefined };
}

function renderView(client = fakeClient(), chips?: ComposerContextChips) {
  const rows = new RowRequests(async () => undefined);
  const workbench = actions();
  const tab = handle();
  render(<PullRequestView params={PARAMS} handle={tab} actions={workbench} client={client} chips={() => chips} rows={rows} />);
  return { client, rows, workbench, tab };
}

describe("the pull-request view", () => {
  it("shows the summary: title, branches, reviewers, labels, checks and comments, and names the tab", async () => {
    const { tab, rows } = renderView();
    expect(await screen.findByRole("heading", { name: "Add the output helper" })).toBeTruthy();
    expect(screen.getByText("feat/output")).toBeTruthy();
    expect(screen.getByTitle("mona — Changes requested")).toBeTruthy();
    expect(screen.getByTitle("hubot — Review requested")).toBeTruthy();
    expect(screen.getByText("enhancement")).toBeTruthy();
    expect(screen.getByLabelText("Checks summary").textContent).toContain("1 of 4 failing");
    // Failing checks open their section.
    expect(within(screen.getByRole("list", { name: "Checks" })).getByText("smoke")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Comments (6)")).toBeTruthy());
    expect(screen.getByText("The offset counts the chunk's end.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "kits/terminal/output.ts:10" })).toHaveLength(2);
    expect(tab.setTitle).toHaveBeenCalledWith("PR #7 Add the output helper");
    expect(rows.get("/project")).toMatchObject<Partial<UiReviewRequest>>({ number: 7, checks: { passed: 2, failed: 1, pending: 1, total: 4 } });
  });

  it("says what went wrong when the request cannot be read, and retries", async () => {
    let fail = true;
    const client = fakeClient({ view: vi.fn(async () => { if (fail) throw new Error("GitHub CLI (gh) is not signed in."); return parseGitHubDetail(REF, fixture("gh-pr-view-discussed.json")); }) });
    renderView(client);
    expect((await screen.findByRole("alert")).textContent).toContain("not signed in");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Add the output helper" })).toBeTruthy();
  });

  it("edits the title with Enter and the description with ⌘↵", async () => {
    const { client } = renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Replay output once" } });
    fireEvent.keyDown(title, { key: "Enter" });
    await waitFor(() => expect(client.update).toHaveBeenCalledWith(REF.url, { title: "Replay output once" }));
    expect(await screen.findByRole("heading", { name: "Replay output once" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const body = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(body, { target: { value: "Now it replays once." } });
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    await waitFor(() => expect(client.update).toHaveBeenCalledWith(REF.url, { body: "Now it replays once." }));
  });

  it("posts a comment on the request from the floating composer", async () => {
    const { client } = renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on PR #7" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Thanks!" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(client.comment).toHaveBeenCalledWith(REF.url, { body: "Thanks!" }));
  });

  it("lists the timeline newest first and flips it", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("tab", { name: "Timeline" }));
    const timeline = await screen.findByRole("list", { name: "PR #7 timeline" });
    const rows = () => within(timeline).getAllByRole("listitem").map((row) => row.className.split(" ")[1]);
    expect(rows()).toEqual(["verdict", "conversation", "lifecycle", "commit"]);
    fireEvent.click(screen.getByRole("button", { name: "Newest first" }));
    expect(rows()).toEqual(["commit", "lifecycle", "conversation", "verdict"]);
  });

  it("draws a thread under its line, replies to it, marks a file viewed and comments on a line", async () => {
    const chips = { addChip: vi.fn(() => "chip"), removeChip: vi.fn() };
    const { client } = renderView(fakeClient(), chips);
    await screen.findByRole("heading", { name: "Add the output helper" });
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(client.files).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: /output\.ts/u }));
    const thread = await screen.findByRole("region", { name: "Conversation on kits/terminal/output.ts:10" });
    expect(within(thread).getByText("The offset counts the chunk's end.")).toBeTruthy();
    // The outdated thread is listed apart from the diff.
    expect(screen.getByText(/Conversations not on the current diff \(1\)/u)).toBeTruthy();

    fireEvent.click(within(thread).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(thread).getByRole("textbox", { name: "Reply to this conversation" }), { target: { value: "Renamed." } });
    fireEvent.keyDown(within(thread).getByRole("textbox", { name: "Reply to this conversation" }), { key: "Enter", metaKey: true });
    await waitFor(() => expect(client.comment).toHaveBeenCalledWith(REF.url, { threadId: "PRRT_1", body: "Renamed." }));

    fireEvent.click(within(thread).getByRole("button", { name: "Send conversation to composer" }));
    expect(chips.addChip).toHaveBeenCalledWith(expect.objectContaining({ kind: "text-excerpt", label: "Thread on output.ts:10" }));

    // GitHub dismissed the earlier mark: the file changed since.
    const viewed = screen.getByRole("checkbox");
    expect(viewed.closest("label")?.textContent).toBe("Changed");
    await act(async () => { fireEvent.click(viewed); });
    await waitFor(() => expect(client.viewed).toHaveBeenCalledWith(REF.url, "kits/terminal/output.ts", true));

    fireEvent.click(screen.getByRole("button", { name: /output\.ts/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 3" }), { target: { value: "Name this." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(client.comment).toHaveBeenCalledWith(REF.url, { path: "kits/terminal/output.ts", line: 3, side: "new", body: "Name this." }));
  });
});
