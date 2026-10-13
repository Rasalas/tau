// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import AutomationsPage from "./page.js";
import { SchedulingFeed } from "./feed.js";
import type { Job, ManagementState } from "./protocol.js";
import PrivateSecret from "./secret-card.js";

afterEach(cleanup);
const job: Job = { id: "job-1", workspaceId: "host:/project", enabled: true, status: "ready", nextAt: "2026-10-08T09:00:00Z", config: { workspaceStrategy: "worktree", accessLevel: "read-only", maxDurationMinutes: 60, name: "Morning digest", workspace: "/project", backend: "pi", prompt: "Inspect CI", schedule: { kind: "daily", time: "09:00", timezone: "UTC" } } };
function setup(patch: Partial<ManagementState> = {}, privateCard = false, params: Record<string, unknown> = {}) {
  let state: ManagementState = { enabled: true, jobs: [structuredClone(job)], canManage: true, defaultAccessLevel: "full", secretRequests: [], ...patch };
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "manage") return structuredClone(state);
    if (command === "create") { const created = { ...job, config: input, enabled: false }; state = { ...state, jobs: [...state.jobs, created as Job] }; return created; }
    if (command === "update") return state.jobs[0];
    if (command === "save-secret" || command === "decline-secret") state = { ...state, secretRequests: [] };
    return undefined;
  });
  const host = { invoke, onEvent: () => () => undefined } as HostExtensionClient;
  const feed = new SchedulingFeed(host);
  const actions = { activeThread: () => ({ sessionId: "thread-1", cwd: "/project", backendKind: "pi", draftPending: false }), runtimeModels: async () => [{ backend: { kind: "pi", label: "Pi" } }], openThread: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions;
  const draw = (pageParams: Record<string, unknown>) => <TestProviders><TestThreadStore projects={[{ path: "/project", name: "Tau", lastOpenedAt: 0 }]} threads={[]}>
    {privateCard ? <><div className="composer-frame"><textarea defaultValue="Unsent draft" aria-label="Composer" /></div><PrivateSecret feed={feed} actions={actions} /></> : <AutomationsPage actions={actions} params={pageParams} navigate={vi.fn()} close={vi.fn()} feed={feed} />}
  </TestThreadStore></TestProviders>;
  const view = render(draw(params));
  return { invoke, actions, reopen: () => view.rerender(draw({ ...params })) };
}

it("opens the automation requested by the project card and stays closed after saving", async () => {
  const h = setup({}, false, { edit: "job-1" });
  const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Morning digest");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("update", expect.objectContaining({ id: "job-1" })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
  h.reopen();
  const reopened = await screen.findByRole("dialog", { name: "Edit automation" });
  expect((within(reopened).getByLabelText("Name") as HTMLInputElement).value).toBe("Morning digest");
});

it("shows recovery states separately and requires duplicate acknowledgement for an uncertain retry", async () => {
  const uncertain = { ...job, status: "uncertain" as const, lastRun: { intentId: "intent", at: "2026-10-07T09:00:00Z", outcome: "uncertain", threadId: "maybe-started" } };
  const h = setup({ jobs: [uncertain] });
  fireEvent.click(await screen.findByRole("button", { name: "Resolve…" }));
  const dialog = await screen.findByRole("dialog", { name: "Resolve Morning digest" });
  expect((within(dialog).getByRole("radio", { name: "Skip this run" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByRole("radio", { name: "Run it again now" }));
  const confirm = within(dialog).getByRole("button", { name: "Confirm decision" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("checkbox"));
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("resolve", { id: "job-1", decision: "run", acknowledgeDuplicateRisk: true }));
});

it("paired devices can inspect jobs but cannot edit or retry them", async () => {
  setup({ canManage: false, jobs: [{ ...job, status: "held" }] });
  expect((await screen.findByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "New automation" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Manage them in this machine's own Tau window/)).toBeTruthy();
});

it("creates and enables from one form with the current thread's project and runtime", async () => {
  const h = setup({ jobs: [] });
  fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
  const dialog = await screen.findByRole("dialog", { name: "New automation" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Daily review" } });
  fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Inspect changes" } });
  expect((within(dialog).getByLabelText("Project") as HTMLSelectElement).value).toBe("/project");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", { workspaceStrategy: "worktree", maxDurationMinutes: 60, name: "Daily review", prompt: "Inspect changes", workspace: "/project", backend: "pi", schedule: { kind: "daily", time: "09:00", timezone: "UTC" } }));
  expect(h.invoke).toHaveBeenCalledWith("enable", { id: "job-1" });
});

it("private secret cards mask input, preserve a draft's focus and send the value only to the owner command", async () => {
  const h = setup({ secretRequests: [{ id: "request-1", threadId: "thread-1", jobId: "job-1", label: "CI signature", reason: "Verify this webhook", status: "pending", expiresAt: Date.now() + 10000 }] }, true);
  const input = await screen.findByLabelText("CI signature");
  expect(input.getAttribute("type")).toBe("password");
  expect(document.activeElement).not.toBe(input);
  fireEvent.change(input, { target: { value: "private-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save privately" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("save-secret", { id: "request-1", value: "private-test-key" }));
  expect((screen.getByLabelText("Composer") as HTMLTextAreaElement).value).toBe("Unsent draft");
  expect(document.body.textContent).not.toContain("private-test-key");
});


it("offers the new-thread access default and saves explicit execution settings", async () => {
  const h = setup({ jobs: [], defaultAccessLevel: "auto" });
  fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
  const dialog = await screen.findByRole("dialog", { name: "New automation" });
  const workspace = within(dialog).getByRole("combobox", { name: /^Workspace/u }) as HTMLSelectElement;
  const access = within(dialog).getByRole("combobox", { name: /^Access/u }) as HTMLSelectElement;
  const duration = within(dialog).getByLabelText("Maximum duration in minutes") as HTMLInputElement;
  expect(workspace.value).toBe("worktree");
  expect(access.value).toBe("auto");
  expect(duration.value).toBe("60");
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Checkout task" } });
  fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Inspect" } });
  fireEvent.change(workspace, { target: { value: "current" } });
  fireEvent.change(access, { target: { value: "ask" } });
  fireEvent.change(duration, { target: { value: "15" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", expect.objectContaining({ workspaceStrategy: "current", accessLevel: "ask", maxDurationMinutes: 15 })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New automation" })).toBeNull());
});


it.each(["full", "ask", "read-only"] as const)("shows the current new-thread default %s without submitting an explicit access choice", async (defaultAccessLevel) => {
  const h = setup({ jobs: [], defaultAccessLevel });
  fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
  const dialog = await screen.findByRole("dialog", { name: "New automation" });
  expect((within(dialog).getByRole("combobox", { name: /^Access/u }) as HTMLSelectElement).value).toBe(defaultAccessLevel);
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Default task" } });
  fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Inspect" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", expect.objectContaining({ name: "Default task" })));
  const created = h.invoke.mock.calls.find(([command]) => command === "create")![1] as Record<string, unknown>;
  expect(created).not.toHaveProperty("accessLevel");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New automation" })).toBeNull());
});

it("keeps a saved access choice when the new-thread default differs", async () => {
  const h = setup({ defaultAccessLevel: "full" }, false, { edit: "job-1" });
  const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
  expect((within(dialog).getByRole("combobox", { name: /^Access/u }) as HTMLSelectElement).value).toBe("read-only");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("update", expect.objectContaining({ config: expect.objectContaining({ accessLevel: "read-only" }) })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
});
