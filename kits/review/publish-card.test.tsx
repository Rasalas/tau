// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PreferencesStore, UiWorkspaceChanges, WorkbenchActions } from "tau";
import { createPublishCardLayer, RequestPublishing, type PublishParts } from "./publish-card.js";
import type { LocalRequestClient } from "./local-request-client.js";
import type { ReviewRequestStatus, WorkspaceStoreApi } from "./protocol.js";
import type { RequestClient, RowRequests } from "./requests.js";
import type { WorkspaceChangesReader } from "./workspace.js";

afterEach(cleanup);

const preferences = { value: () => undefined, optionValue: (_id: string, _option: string, fallback: unknown) => fallback, subscribe: () => () => undefined, getSnapshot: () => ({}) } as unknown as PreferencesStore;
const STATUS: ReviewRequestStatus = { branch: "feat/card", base: "main", service: "github", remote: "git@github.com:acme/demo.git" };
const OPEN = { provider: "github", number: 7, title: "Card", url: "https://github.com/acme/demo/pull/7", baseRef: "main", state: "open" } as const;

const file = (name: string, staged = false) => ({ path: `src/${name}`, name, directory: "src", status: "modified" as const, added: 2, removed: 1, ...(staged ? { staged: true } : {}) });

interface Options {
  files?: ReturnType<typeof file>[];
  status?: Partial<ReviewRequestStatus>;
  message?: string;
  suggest?: () => Promise<string | undefined>;
  describe?: LocalRequestClient["describe"];
  values?: Record<string, string>;
}

function setup(options: Options = {}) {
  const files = options.files ?? [file("a.ts")];
  const changes: UiWorkspaceChanges = { files, added: files.length * 2, removed: files.length, branch: "feat/card", proposedMessage: "Update files" };
  const store = {
    getSnapshot: vi.fn(() => ({ cwd: "/work", workspaceId: "w1", changes, committing: false, workspace: { branch: "feat/card" } })),
    suggestCommitMessage: vi.fn(options.suggest ?? (async () => "feat(card): preview")),
    refresh: vi.fn(async () => undefined),
  } as unknown as WorkspaceStoreApi;
  const workspace = { invoke: vi.fn<HostExtensionClient["invoke"]>(async () => ({})), onEvent: () => () => undefined } satisfies HostExtensionClient;
  const requests = {
    status: vi.fn(async () => ({ ...STATUS, ...options.status })),
    create: vi.fn(async () => ({ status: { ...STATUS, request: OPEN } })),
  } as unknown as RequestClient;
  const client = { describe: vi.fn(options.describe ?? (async () => ({ title: "Preview the request", body: "Both texts first.", base: "main", generated: true }))) } as unknown as LocalRequestClient;
  const reader = { fileDiff: vi.fn(async (path: string) => ({ path, added: 2, removed: 1, hunks: [] })), changes: vi.fn() } as unknown as WorkspaceChangesReader;
  const rows = { set: vi.fn() } as unknown as RowRequests;
  const parts: PublishParts = { store: () => store, workspace, requests, client, changes: reader, rows, preferences: options.values ? { ...preferences, value: (_id, key) => options.values?.[key] } as PreferencesStore : preferences };
  const publishing = new RequestPublishing();
  const dismiss = vi.fn();
  const actions = { toast: vi.fn(() => ({ id: "publish-error", dismiss, update: vi.fn() })), notify: vi.fn(), activeThread: () => ({ sessionId: "t1", cwd: "/work", model: { provider: "openai", id: "gpt" }, draftPending: false }), openStageTab: vi.fn(() => "tab") } as unknown as WorkbenchActions;
  const Layer = createPublishCardLayer(publishing, parts);
  render(<Layer actions={actions} />);
  act(() => publishing.show(options.message ? { message: options.message } : {}));
  return { store, workspace, requests, client, reader, actions, publishing, dismiss };
}

const card = () => screen.findByRole("dialog", { name: "Commit, push & PR" });

describe("the Commit, push & PR card", () => {
  it("uses the description's model and effort from Text generation for the request description", async () => {
    // Review's activation copies an older commit model here (`migrateTextGeneration`).
    const { client } = setup({ values: { "pr-model": "test/writer", "pr-effort": "high" } });
    await waitFor(() => expect(client.describe).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "test", id: "writer" }, thinkingLevel: "high" })));
  });

  it.each(["fatal", "error"])("shows only the %s reason and keeps the full Git output for copying", async (prefix) => {
    const { workspace, actions, dismiss } = setup();
    const output = `Command failed: /usr/bin/git -c core.quotePath=false -c core.fsmonitor=false push --set-upstream origin HEAD:refs/heads/feat/card\n${prefix}: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n`;
    vi.mocked(workspace.invoke).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error(output)).mockRejectedValueOnce(new Error(output));
    const dialog = await card();
    const confirm = within(dialog).getByRole("button", { name: "Commit, push & PR" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    const retry = await within(dialog).findByRole("button", { name: "Try again" });
    expect(actions.toast).toHaveBeenCalledWith(expect.objectContaining({
      type: "error", title: "Pushing failed: Could not read from remote repository.", copyText: output,
    }));
    expect(dismiss).not.toHaveBeenCalled();
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(actions.toast).toHaveBeenCalledTimes(2));
    expect(actions.toast).toHaveBeenLastCalledWith(expect.objectContaining({ id: "publish-error", copyText: output }));
    expect(dismiss).not.toHaveBeenCalled();
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(dismiss).toHaveBeenCalledOnce();
    expect(vi.mocked(workspace.invoke).mock.calls.map(([command]) => command)).toEqual(["commit", "push", "push", "push"]);
  });

  it("dismisses a recovered push error even when request creation then fails", async () => {
    const { workspace, requests, dismiss } = setup();
    vi.mocked(workspace.invoke).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Push refused."));
    vi.mocked(requests.create).mockRejectedValue(new Error("Request refused."));
    const dialog = await card();
    const confirm = within(dialog).getByRole("button", { name: "Commit, push & PR" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    const retry = await within(dialog).findByRole("button", { name: "Try again" });
    expect(dismiss).not.toHaveBeenCalled();
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    await within(dialog).findByText("Creating PR failed");
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("lists the staged files, else every changed one, with a count of the rest", async () => {
    const many = Array.from({ length: 10 }, (_, index) => file(`f${index}.ts`));
    setup({ files: many });
    expect((await within(await card()).findByLabelText("10 changed files")).querySelectorAll("li")).toHaveLength(9);
    expect(screen.getByText("and 2 more")).toBeTruthy();
    cleanup();
    setup({ files: [file("a.ts"), file("b.ts", true), file("c.ts")] });
    const list = await within(await card()).findByLabelText("1 changed file");
    expect(list.textContent).toContain("b.ts");
    expect(list.textContent).not.toContain("a.ts");
  });

  it("shows a loading state while the texts are written, then lets both be edited", async () => {
    let finish!: (draft: Awaited<ReturnType<LocalRequestClient["describe"]>>) => void;
    const { client } = setup({ describe: () => new Promise((resolve) => { finish = resolve; }) });
    const dialog = await card();
    const confirm = within(dialog).getByRole("button", { name: "Commit, push & PR" }) as HTMLButtonElement;
    await waitFor(() => expect(client.describe).toHaveBeenCalled());
    const title = within(dialog).getByRole("textbox", { name: "PR title" }) as HTMLInputElement;
    expect(title.disabled).toBe(true);
    expect(title.placeholder).toBe("Writing from the commits…");
    expect(confirm.disabled).toBe(true);
    await act(async () => { finish({ title: "Preview the request", body: "Both texts first.", base: "main", generated: true }); });
    expect(title.disabled).toBe(false);
    expect(title.value).toBe("Preview the request");
    fireEvent.change(title, { target: { value: "Edited title" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Commit message" }), { target: { value: "fix(card): edited" } });
    expect(confirm.disabled).toBe(false);
  });

  it("writes the description for the commit it is about to make, and takes a message already written as it is", async () => {
    const { client, store } = setup({ message: "feat(review): mine" });
    await card();
    await waitFor(() => expect(client.describe).toHaveBeenCalledWith(expect.objectContaining({ pending: { message: "feat(review): mine", files: [{ path: "src/a.ts", added: 2, removed: 1 }] } })));
    expect(store.suggestCommitMessage).not.toHaveBeenCalled();
  });

  it("says what could not be written and leaves both texts to be typed", async () => {
    const { requests, workspace } = setup({
      suggest: async () => { throw new Error("No model is selected for commit message generation."); },
      describe: async () => { throw new Error("The model answered without a title; try again."); },
    });
    const dialog = await card();
    expect(await within(dialog).findByText("Could not write a message from the diff: No model is selected for commit message generation.")).toBeTruthy();
    expect(within(dialog).getByText("Could not write the description: The model answered without a title; try again.")).toBeTruthy();
    // The host's own proposal stands in for the message.
    expect((within(dialog).getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("Update files");
    const confirm = within(dialog).getByRole("button", { name: "Commit, push & PR" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "PR title" }), { target: { value: "By hand" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(requests.create).toHaveBeenCalledWith({ workspace: "w1", branch: "feat/card", title: "By hand", body: "", base: "", draft: false }));
    expect(workspace.invoke).toHaveBeenCalledWith("commit", { message: "Update files", push: false, workspace: "w1" });
    expect(workspace.invoke).toHaveBeenCalledWith("push", { workspace: "w1" });
  });

  it("keeps creation on the displayed checkout when the workspace changes before confirmation", async () => {
    const { store, requests, workspace } = setup({ message: "Update the card" });
    const dialog = await card();
    const confirm = within(dialog).getByRole("button", { name: "Commit, push & PR" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    vi.mocked(store.getSnapshot).mockReturnValue({
      ...store.getSnapshot(), cwd: "/other", workspaceId: "w2", workspace: { branch: "other-branch" },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(requests.create).toHaveBeenCalledWith({ workspace: "w1", branch: "feat/card", title: "Preview the request", body: "Both texts first.", base: "", draft: false }));
    expect(requests.status).toHaveBeenCalledWith(false, "w1");
    expect(workspace.invoke).toHaveBeenCalledWith("push", { workspace: "w1" });
  });

  it("will not confirm where the host cannot open a request, and says why", async () => {
    setup({ status: { problem: "GitHub CLI (gh) is not installed or not on your PATH." } });
    const dialog = await card();
    expect(await within(dialog).findByText("GitHub CLI (gh) is not installed or not on your PATH.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByPlaceholderText("Writing from the commits…")).toBeNull());
    expect((within(dialog).getByRole("button", { name: "Commit, push & PR" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("words the card and its steps for a merge request", async () => {
    setup({ status: { service: "gitlab" } });
    const dialog = await screen.findByRole("dialog", { name: "Commit, push & PR" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Commit, push & MR" })).toBeTruthy());
    expect(within(dialog).getByRole("list", { name: "Progress" }).textContent).toBe("CommitPushCreate MR");
  });
});

it("defaults maintainer edits on for a confirmed personal fork and forwards an explicit opt-out", async () => {
  const { requests } = setup({ status: { canChooseMaintainerEdits: true } });
  const dialog = await card();
  const toggle = await within(dialog).findByRole("checkbox", { name: /Allow edits from maintainers/ });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(toggle);
  const confirm = within(dialog).getByRole("button", { name: "Commit, push & PR" });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect(requests.create).toHaveBeenCalledWith(expect.objectContaining({ maintainerCanModify: false })));
});
