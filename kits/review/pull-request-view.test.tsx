// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, PreferencesStore, StageTabHandle, UiReviewRequest, WorkbenchActions } from "tau";
import { PendingReviewStore } from "./pending-review.js";
import type { ComposerContextChips, PullRequestDetail, PullRequestFiles } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseGitHubDetail, parseGitHubThreads, parseRequestUrl, parseUnifiedDiff } from "./pull-request-json.js";
import { PullRequestView } from "./pull-request-view.js";
import { RowRequests } from "./requests.js";
import { ThreadLinkRows } from "./thread-links-store.js";

afterEach(cleanup);

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const REF = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const FIRST_COMMENT = (JSON.parse(fixture("gh-pr-view-discussed.json")) as { comments: Array<{ body: string }> }).comments[0]!.body.trim();
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
    review: vi.fn(async () => detail),
    resolve: vi.fn(async (_url: string, id: string, resolved: boolean) => threads.map((thread) => thread.id === id ? { ...thread, resolved } : thread)),
    editComment: vi.fn(async () => undefined),
    reviewers: vi.fn(async () => detail),
    labels: vi.fn(async () => detail),
    candidates: vi.fn(async () => ({ labels: [{ name: "bug" }, { name: "enhancement" }], reviewers: ["octo", "mona", "lisa"] })),
    list: vi.fn(async () => { throw new Error("not in this test"); }),
    links: vi.fn(async () => []),
    link: vi.fn(async (_thread: string, url: string) => ({ link: { url, service: "github" as const, host: "github.com", repo: "acme/tau", number: 7, source: "user" as const, linkedAt: 1 }, alreadyLinked: false })),
    unlink: vi.fn(async () => true),
    onLinksChanged: () => () => undefined,
    ...overrides,
  };
}

/** A client storage in memory, as a test's own. */
function memoryStorage(): ClientStorage {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: (key) => { values.delete(key); }, keys: () => [...values.keys()] };
}

/** The two options the view reads, and nothing else of the store. */
function preferences(): PreferencesStore {
  const options = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let snapshot = {};
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    optionValue: (_extension: string, id: string, fallback: unknown) => options.has(id) ? options.get(id) : fallback,
    setOption: (_extension: string, id: string, value: unknown) => { options.set(id, value); snapshot = {}; for (const listener of listeners) listener(); },
  } as unknown as PreferencesStore;
}

function actions(): WorkbenchActions {
  return {
    activeThread: () => ({ sessionId: "thread-1", cwd: "/project", draftPending: false }),
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
  const storage = memoryStorage();
  const shared = { links: new ThreadLinkRows(client), pending: new PendingReviewStore(() => storage, () => `held-${storage.keys().length}-${Math.random()}`), preferences: preferences() };
  render(<PullRequestView params={PARAMS} handle={tab} actions={workbench} client={client} chips={() => chips} rows={rows} shared={shared} />);
  return { client, rows, workbench, tab, shared };
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
    fireEvent.click(await screen.findByRole("button", { name: "Comment on or review PR #7" }));
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
    const viewed = screen.getByRole("checkbox", { name: "Changed" });
    expect(viewed.closest("label")?.textContent).toBe("Changed");
    await act(async () => { fireEvent.click(viewed); });
    await waitFor(() => expect(client.viewed).toHaveBeenCalledWith(REF.url, "kits/terminal/output.ts", true));

    fireEvent.click(screen.getByRole("button", { name: /output\.ts/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 3" }), { target: { value: "Name this." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(client.comment).toHaveBeenCalledWith(REF.url, { path: "kits/terminal/output.ts", line: 3, side: "new", body: "Name this." }));
  });

  it("holds line comments for a review and submits them with a verdict in one step", async () => {
    const { client, shared } = renderView();
    await screen.findByRole("heading", { name: "Add the output helper" });
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    fireEvent.click(await screen.findByRole("button", { name: /output\.ts/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 3" }), { target: { value: "Name this." } });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    expect(await screen.findByLabelText("Pending comment on line 3")).toBeTruthy();
    expect(client.comment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Comment on or review PR #7" }));
    const composer = screen.getByRole("dialog", { name: "Review the pull request" });
    expect(within(composer).getByRole("list", { name: "Line comments in this review" }).textContent).toContain("Name this.");
    fireEvent.click(within(composer).getByRole("radio", { name: "Request changes" }));
    fireEvent.change(within(composer).getByRole("textbox", { name: "Review summary" }), { target: { value: "One thing." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Submit review (1)" }));
    await waitFor(() => expect(client.review).toHaveBeenCalledWith(REF.url, {
      event: "request-changes",
      body: "One thing.",
      comments: [expect.objectContaining({ path: "kits/terminal/output.ts", line: 3, side: "new", body: "Name this." })],
    }));
    await waitFor(() => expect(shared.pending.comments(REF.url)).toEqual([]));
  });

  it("resolves a conversation, hides whitespace changes and links the request to the thread", async () => {
    const { client, shared } = renderView();
    await screen.findByRole("heading", { name: "Add the output helper" });
    fireEvent.click(screen.getByRole("button", { name: "Link to this thread" }));
    await waitFor(() => expect(client.link).toHaveBeenCalledWith("thread-1", REF.url, "/project"));

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    fireEvent.click(await screen.findByRole("button", { name: /output\.ts/u }));
    const thread = await screen.findByRole("region", { name: "Conversation on kits/terminal/output.ts:10" });
    fireEvent.click(within(thread).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(client.resolve).toHaveBeenCalledWith(REF.url, "PRRT_1", true));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Conversation on kits/terminal/output.ts:10" })).getByRole("button", { name: "Unresolve" })).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace" }));
    expect(shared.preferences.optionValue("tau.review", "diff-ignore-whitespace", false)).toBe(true);
  });

  it("offers to edit only the signed-in account's own comments, and changes labels", async () => {
    const detail = { ...parseGitHubDetail(REF, fixture("gh-pr-view-discussed.json")), viewer: "octo" };
    const { client } = renderView(fakeClient({ view: vi.fn(async () => detail) }));
    await waitFor(() => expect(screen.getByText("Comments (6)")).toBeTruthy());
    // octo wrote one comment on the request and one reply in a thread; mona's are not theirs to edit.
    expect(await screen.findAllByRole("button", { name: "Edit comment" })).toHaveLength(2);
    const own = screen.getByText(FIRST_COMMENT).closest("article")!;
    fireEvent.click(within(own as HTMLElement).getByRole("button", { name: "Edit comment" }));
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    fireEvent.change(editor, { target: { value: "Edited." } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await waitFor(() => expect(client.editComment).toHaveBeenCalledWith(REF.url, expect.objectContaining({ id: "IC_1", kind: "comment" }), "Edited."));

    fireEvent.click(screen.getByRole("button", { name: "Remove the label enhancement" }));
    await waitFor(() => expect(client.labels).toHaveBeenCalledWith(REF.url, { remove: ["enhancement"] }));
    fireEvent.click(screen.getByRole("button", { name: "Request a review" }));
    fireEvent.click(await screen.findByRole("option", { name: "lisa" }));
    await waitFor(() => expect(client.reviewers).toHaveBeenCalledWith(REF.url, { add: ["lisa"] }));
  });
});
