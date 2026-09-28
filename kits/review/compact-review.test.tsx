// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PanelProps, UiFileDiff, UiWorkspaceChanges, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { ReviewCommentStore } from "./comments.js";
import { createCompactReview } from "./compact-review.js";
import { CompactReviewStore } from "./compact-store.js";
import type { RequestClient } from "./requests.js";
import type { ReviewTurn } from "./protocol.js";
import type { ReviewSource } from "./compact-model.js";

afterEach(cleanup);

const FILE = { path: "src/a.ts", name: "a.ts", directory: "src", status: "modified" as const, added: 2, removed: 1 };
const TURN: ReviewTurn = { id: "cp1", sessionId: "s1", startedAt: 1, endedAt: 2, files: [FILE], fileCount: 1, added: 2, removed: 1 };
const WORKTREE: UiWorkspaceChanges = { branch: "feat/x", files: [FILE, { ...FILE, path: "b.ts", name: "b.ts", directory: "" }], added: 4, removed: 2 };
const BRANCH: UiWorkspaceChanges = { branch: "feat/x", scope: "branch", baseRef: "origin/main", baseCommit: "abc", files: [FILE], added: 2, removed: 1 };
const DIFF: UiFileDiff = {
  path: "src/a.ts",
  added: 2,
  removed: 1,
  hunks: [{ header: "@@ -1,2 +1,3 @@", lines: [
    { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
    { kind: "removed", oldLine: 2, text: "const b = 2;" },
    { kind: "added", newLine: 2, text: "const b = 3;" },
    { kind: "added", newLine: 3, text: "const c = 4;" },
  ] }],
};

function setup(options: { readOnly?: boolean; turns?: ReviewTurn[]; ahead?: number; source?: ReviewSource } = {}) {
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    switch (command) {
      case "checkpoints": return { checkpoints: options.turns ?? [TURN], restoreSupported: false };
      case "turn-file-diff": return DIFF;
      case "workspace-info": return { root: "/p", isRepo: true, isDirty: true, branch: "feat/x", upstream: "origin/feat/x", ahead: options.ahead ?? 0, hasRemote: true, worktrees: [], refs: [], worktreeParent: "/w" };
      case "commit": return { changes: { files: [], added: 0, removed: 0 }, pushed: (input as { push: boolean }).push, detail: "Committed 1234567" };
      case "push": return { detail: "Pushed feat/x" };
      default: throw new Error(`unexpected ${command}`);
    }
  });
  const workspace: HostExtensionClient = { invoke, onEvent: () => () => undefined };
  const reader = {
    changes: vi.fn(async (query?: { scope?: string }) => query?.scope === "branch" ? BRANCH : WORKTREE),
    fileDiff: vi.fn(async () => DIFF),
  };
  const requests = {
    status: vi.fn(async () => ({ branch: "feat/x", base: "main", service: "github" as const })),
    draft: vi.fn(async () => ({ title: "Add c", body: "Adds c.", base: "main", generated: true })),
    create: vi.fn(async () => ({ status: { base: "main", service: "github" as const }, url: "https://example.test/pr/1" })),
  } as unknown as RequestClient;
  const comments = new ReviewCommentStore(() => undefined, () => "c1");
  const store = new CompactReviewStore();
  if (options.source) store.update({ sessionId: "s1", source: options.source });
  const Panel = createCompactReview({ reader, workspace, requests, comments, store });
  const actions = {
    activeThread: () => ({ sessionId: "s1", cwd: "/p" }),
    notify: vi.fn(),
    closePanel: vi.fn(),
    composerDraft: () => "Earlier words",
    focusComposer: vi.fn(),
  } as unknown as WorkbenchActions;
  const client = createFakeHostClient({ isReadOnly: () => options.readOnly === true });
  const props = { active: true, placement: "stage", extensionName: "Review Kit", actions } as PanelProps;
  render(<HostClientProvider client={client}><Panel {...props} /></HostClientProvider>);
  return { invoke, reader, requests, actions, store, comments };
}

const button = (name: RegExp | string) => screen.findByRole("button", { name });
/** A button once it may be pressed: several wait for the branch's status or for a step to finish. */
async function enabledButton(name: RegExp | string): Promise<HTMLButtonElement> {
  const found = await button(name) as HTMLButtonElement;
  await waitFor(() => expect(found.disabled).toBe(false));
  return found;
}

describe("the review on a compact client", () => {
  it("opens on the latest turn and sends a comment on a range into the composer", async () => {
    const { actions, invoke } = setup();
    expect(await button(/Diff: Latest turn \(turn 1\)/)).toBeTruthy();
    fireEvent.click(await button(/a\.ts/));
    fireEvent.click(await button("Select line 2"));
    fireEvent.click(await button("Select line 3"));
    expect(invoke).toHaveBeenCalledWith("turn-file-diff", { sessionId: "s1", checkpointId: "cp1", relPath: "src/a.ts", options: { hunkLimit: 40 } });
    fireEvent.click(await button("Comment on lines 2–3"));
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Keep b at 2." } });
    fireEvent.click(await button("Add to the composer"));
    expect(actions.closePanel).toHaveBeenCalledWith("review");
    const text = vi.mocked(actions.focusComposer).mock.calls[0]?.[0] ?? "";
    expect(text).toMatch(/^Earlier words\n\nFrom Review comment on src\/a\.ts:2-3:\n> Keep b at 2\./u);
    expect(text).toContain("> + const b = 3;");
  });

  it("opens on a turn picked before the sheet, once the turn list has loaded", async () => {
    const older: ReviewTurn = { ...TURN, id: "cp0", endedAt: 1, files: [{ ...FILE, path: "old.ts", name: "old.ts", directory: "" }] };
    setup({ turns: [older, TURN], source: { kind: "turn", id: "cp0" } });
    expect(await button(/Diff: Turn 1/)).toBeTruthy();
    expect(await button(/old\.ts/)).toBeTruthy();
    expect(screen.queryByText("This turn's changes are no longer recorded.")).toBeNull();
  });

  it("keeps an unsent comment when the diff is left, and asks before dropping one with words", async () => {
    const { comments } = setup();
    fireEvent.click(await button(/a\.ts/));
    fireEvent.click(await button("Select line 1"));
    fireEvent.click(await button("Comment on line 1"));
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Why?" } });
    fireEvent.click(await button(/Back to the diff/));
    fireEvent.click(await button(/Back to the files/));
    expect(await screen.findByText(/An unsent comment on src\/a\.ts:1/u)).toBeTruthy();
    fireEvent.click(await button("Continue"));
    expect((await screen.findByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Why?");
    fireEvent.click(await button(/Back to the diff/));
    fireEvent.click(await button("Clear the selection"));
    const dialog = await screen.findByRole("dialog", { name: "Discard the comment?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(comments.getSnapshot().draft?.body).toBe("Why?");
  });

  it("commits the working tree only after the question", async () => {
    const { invoke, actions } = setup();
    fireEvent.click(await button(/Diff: /));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Uncommitted changes/ }));
    fireEvent.click(await button("Commit…"));
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Fix b" } });
    fireEvent.click(await button("Commit…"));
    const dialog = await screen.findByRole("dialog", { name: "Commit?" });
    expect(dialog.textContent).toContain("Stages and commits all 2 changed files on feat/x: “Fix b”.");
    expect(invoke).not.toHaveBeenCalledWith("commit", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("commit", { message: "Fix b", push: false }));
    await waitFor(() => expect(actions.notify).toHaveBeenCalledWith("Committed 1234567"));
  });

  it("pushes the branch and opens a request only after the question", async () => {
    const { invoke, requests } = setup({ ahead: 2 });
    fireEvent.click(await button(/Diff: /));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Branch changes/ }));
    fireEvent.click(await button("Push"));
    const push = await screen.findByRole("dialog", { name: "Push?" });
    fireEvent.click(within(push).getByRole("button", { name: "Push" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("push"));
    fireEvent.click(await button("Pull request…"));
    fireEvent.click(await enabledButton(/Write title and description/));
    await waitFor(() => expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Add c"));
    // The title shows before the writing step ends.
    fireEvent.click(await enabledButton("Open PR…"));
    const open = await screen.findByRole("dialog", { name: "Open a pull request?" });
    expect(open.textContent).toContain("Pushes feat/x and opens “Add c” into main on GitHub.");
    expect(requests.create).not.toHaveBeenCalled();
    fireEvent.click(within(open).getByRole("button", { name: "Open pull request" }));
    await waitFor(() => expect(requests.create).toHaveBeenCalledWith({ title: "Add c", body: "Adds c.", base: "main", draft: false }));
  });

  it("shows a Read-only device the diffs, with every write disabled and the reason given", async () => {
    const { invoke } = setup({ readOnly: true });
    expect(await screen.findByText(/This device is paired Read only/u)).toBeTruthy();
    fireEvent.click(await button(/a\.ts/));
    await waitFor(() => expect(document.querySelectorAll(".diff-row")).toHaveLength(4));
    expect(screen.queryByRole("button", { name: /Select line/ })).toBeNull();
    expect(screen.queryByText(/Tap a line/u)).toBeNull();
    fireEvent.click(await button(/Back to the files/));
    fireEvent.click(await button(/Diff: /));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Uncommitted changes/ }));
    expect((await button("Commit…") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Read only: writes need a device with Full access/u)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("commit", expect.anything());
  });
});
