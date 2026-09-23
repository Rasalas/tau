// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, HostExtensionClient, PreferencesStore, StageTabHandle, UiSession, WorkbenchActions } from "tau";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import type { LocalRequestClient } from "./local-request-client.js";
import LocalRequestView, { type LocalRequestParts } from "./local-request-view.js";
import { LocalDrafts, type LocalEvidence, type UploadPlan } from "./local-request.js";
import type { ReviewRequest, ReviewRequestStatus, WorkspaceStoreApi } from "./protocol.js";
import type { RequestClient, RowRequests } from "./requests.js";
import type { WorkspaceChangesReader } from "./workspace.js";

afterEach(cleanup);

function memoryStorage(): ClientStorage {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: (key) => { values.delete(key); }, keys: () => [...values.keys()] };
}

const preferences = { value: () => undefined, optionValue: (_id: string, _option: string, fallback: unknown) => fallback, subscribe: () => () => undefined, getSnapshot: () => ({}) } as unknown as PreferencesStore;

const frame = (id: string, caption: string, at: number): LocalEvidence => ({
  threadId: "t1", source: "tau.evidence", id, turnId: "turn1", turnStartedAt: 9_000, turnEndedAt: 15_000, at, mediaType: "image/jpeg", size: 1, width: 960, height: 600, caption,
});

const OPEN: ReviewRequest = { provider: "github", number: 7, title: "Save", url: "https://github.com/acme/demo/pull/7", baseRef: "main", state: "open" };

function setup({ plan = { kind: "github-ref", destination: "refs/tau/evidence/feature/pr in github.com/acme/demo" } as UploadPlan, request }: { plan?: UploadPlan; request?: ReviewRequest } = {}) {
  const status: ReviewRequestStatus = { branch: "feature/pr", base: "main", service: "github", remote: "git@github.com:acme/demo.git", ...(request ? { request } : {}) };
  const client = {
    branch: vi.fn(async () => ({ root: "/work", branch: "feature/pr", base: "main", commits: [{ sha: "c2c2c2c2", subject: "feat: save the page", body: "", at: 20_000 }], forkedAt: 5_000 })),
    evidence: vi.fn(async () => ({ available: true, evidence: [frame("f1", "When the turn started", 9_000), frame("f2", "Clicked “Save”", 14_000)] })),
    image: vi.fn(async () => "data:image/jpeg;base64,AA=="),
    describe: vi.fn(async () => ({ title: "Save the page", body: "## Summary\nIt saves.", base: "main", generated: true, model: "openai/gpt-5.6-luna" })),
    plan: vi.fn(async () => plan),
    attach: vi.fn(async () => ({ uploaded: 1 })),
  } satisfies LocalRequestClient;
  const requests = {
    status: vi.fn(async () => status),
    create: vi.fn(async () => ({ status: { ...status, request: OPEN }, uploaded: plan.kind === "none" ? 0 : 1, kept: plan.kind === "none" ? 1 : 0 })),
  } as unknown as RequestClient;
  const snapshot = { cwd: "/work", workspaceId: "w1", workspace: { branch: "feature/pr" }, changes: { files: [], added: 0, removed: 0 }, committing: false };
  const store = { subscribe: () => () => undefined, getSnapshot: () => snapshot } as unknown as WorkspaceStoreApi;
  const scripts: HostExtensionClient = {
    invoke: vi.fn(async (command: string) => command === "list"
      ? { directory: "/work", exists: true, scripts: [{ id: "test", name: "Test", command: "npm test" }] }
      : command === "runs" ? [{ id: "r1", scriptId: "test", directory: "/work", status: "failed", exitCode: 1, startedAt: Date.now() - 60_000, endedAt: Date.now() }] : undefined),
    onEvent: () => () => undefined,
  };
  const changes: WorkspaceChangesReader = {
    changes: vi.fn(async () => ({ files: [{ path: "site/index.html", name: "index.html", directory: "site", status: "modified" as const, added: 2, removed: 1 }], added: 2, removed: 1, baseCommit: "b0" })),
    fileDiff: vi.fn(async () => ({ path: "site/index.html", added: 2, removed: 1, hunks: [] })),
  };
  const storage = memoryStorage();
  const parts: LocalRequestParts = {
    client, requests, rows: { set: vi.fn() } as unknown as RowRequests, changes, store: () => store, scripts, preferences,
    drafts: new LocalDrafts(() => storage), onEvidence: () => () => undefined,
  };
  const actions = {
    activeThread: () => ({ sessionId: "t1", cwd: "/work", model: { provider: "openai", id: "gpt-5.6-sol" }, draftPending: false }),
    notify: vi.fn(), openStageTab: vi.fn(() => "tab"), openPanel: vi.fn(), copyText: vi.fn(async () => undefined),
  } as unknown as WorkbenchActions;
  const handle = { id: "tab", setTitle: vi.fn(), setDirty: vi.fn(), onClose: () => () => undefined } as unknown as StageTabHandle;
  const threads = [{ id: "t1", title: "Make save work", projectPath: "/work" } as UiSession];
  render(<TestThreadStore threads={threads}><LocalRequestView handle={handle} actions={actions} parts={parts} /></TestThreadStore>);
  return { client, requests, actions, storage, handle };
}

describe("the local pull request view", () => {
  it("shows the branch's pictures under the commit that took in their turn, and the project's scripts as checks", async () => {
    const { handle } = setup();
    expect(await screen.findByRole("region", { name: "Pictures of feat: save the page" })).toBeTruthy();
    expect(screen.getByText(/Make save work · turn at/u)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Open picture:/u })).toHaveLength(2);
    expect(await screen.findByText(/Failed \(exit 1\)/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run Test" })).toBeTruthy();
    expect(handle.setTitle).toHaveBeenCalledWith("Local PR · feature/pr");
  });

  it("writes the description only on a click, with the chosen pictures, and keeps it as the branch's draft", async () => {
    const { client, storage } = setup();
    await screen.findByRole("region", { name: "Pictures of feat: save the page" });
    expect(client.describe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Use in the description: Clicked “Save”" }));
    fireEvent.click(screen.getByRole("button", { name: /Write description/u }));
    await waitFor(() => expect(client.describe).toHaveBeenCalledWith(expect.objectContaining({ prefer: { provider: "openai", id: "gpt-5.6-sol" }, evidence: ["Clicked “Save”"] })));
    const body = await screen.findByRole("textbox", { name: "PR description" }) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toContain("![Clicked “Save”](tau-evidence://t1/tau.evidence/f2)"));
    expect(screen.getByText("Written by openai/gpt-5.6-luna")).toBeTruthy();
    expect(new LocalDrafts(() => storage).get("/work", "feature/pr")).toMatchObject({ title: "Save the page", selected: ["t1\ntau.evidence\nf2"] });
  });

  it("shows where the pictures go before anything is uploaded, then creates with them", async () => {
    const { requests, client } = setup();
    await screen.findByRole("region", { name: "Pictures of feat: save the page" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use in the description: When the turn started" }));
    fireEvent.click(screen.getByRole("button", { name: /Insert 1 picture/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "PR title" }), { target: { value: "Save the page" } });
    fireEvent.click(screen.getByRole("button", { name: "Create PR…" }));
    expect(await screen.findByText("refs/tau/evidence/feature/pr in github.com/acme/demo")).toBeTruthy();
    expect(client.plan).toHaveBeenCalledWith();
    expect(requests.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upload and create PR" }));
    await waitFor(() => expect(requests.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Save the page", uploadConfirmed: true, body: expect.stringContaining("tau-evidence://t1/tau.evidence/f1") })));
  });

  it("says the pictures stay on this machine where the host takes none", async () => {
    const { requests } = setup({ plan: { kind: "none", reason: "GitHub has no upload API for pull requests, and github.com/acme/demo is private." } });
    await screen.findByRole("region", { name: "Pictures of feat: save the page" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use in the description: When the turn started" }));
    fireEvent.click(screen.getByRole("button", { name: /Insert 1 picture/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "PR title" }), { target: { value: "Save" } });
    fireEvent.click(screen.getByRole("button", { name: "Create PR…" }));
    expect(await screen.findByText(/1 picture stays on this machine: GitHub has no upload API/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create PR without pictures" }));
    await waitFor(() => expect(requests.create).toHaveBeenCalledTimes(1));
  });

  it("attaches the chosen pictures to the branch's open request as a comment", async () => {
    const { client } = setup({ request: OPEN });
    await screen.findByRole("region", { name: "Pictures of feat: save the page" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use in the description: Clicked “Save”" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach 1 picture…" }));
    expect(await screen.findByText(/add them to PR #7 as a comment/u)).toBeTruthy();
    expect(client.plan).toHaveBeenCalledWith(OPEN.url, "feature/pr");
    fireEvent.click(screen.getByRole("button", { name: "Upload and comment" }));
    await waitFor(() => expect(client.attach).toHaveBeenCalledWith(expect.objectContaining({ url: OPEN.url, branch: "feature/pr", body: expect.stringContaining("tau-evidence://t1/tau.evidence/f2") })));
  });
});
