// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionClient, UiSession, WorkbenchActions } from "tau";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import AutomationsPage from "./page.js";
import { SchedulingFeed } from "./feed.js";
import type { Job, ManagementState, ScheduleRequest } from "./protocol.js";
import ScheduleProposal from "./schedule-card.js";

afterEach(cleanup);
const thread = (id: string, title: string, extra: Partial<UiSession> = {}) => ({ id, path: `/sessions/${id}.jsonl`, title, modifiedAt: 1, projectPath: "/project", projectName: "Tau", messageCount: 3, ...extra }) as UiSession;
const proposal: ScheduleRequest = { id: "proposal-1", threadId: "thread-1", reason: "You asked for a nightly pass.", status: "pending", expiresAt: Date.now() + 10_000, config: { name: "Nightly cleanup", workspace: "/project", backend: "pi", prompt: "Continue the cleanup.", workspaceStrategy: "worktree", accessLevel: "ask", maxDurationMinutes: 60, schedule: { kind: "cron", expression: "0 21 * * *", timezone: "Europe/Berlin" }, target: { kind: "thread", threadId: "thread-1" } } };

function setup(patch: Partial<ManagementState> = {}, card = false) {
  let state: ManagementState = { enabled: true, jobs: [], canManage: true, defaultAccessLevel: "full", secretRequests: [], secretStore: "Test store", scheduleRequests: [], ...patch };
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "manage") return structuredClone(state);
    if (command === "create") { const created = { id: "job-1", workspaceId: "host:/project", status: "ready", config: input, enabled: false } as Job; state = { ...state, jobs: [created] }; return created; }
    if (command === "approve-schedule" || command === "decline-schedule") state = { ...state, scheduleRequests: [] };
    return undefined;
  });
  const feed = new SchedulingFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient);
  const actions = { activeThread: () => ({ sessionId: "thread-1", cwd: "/project", backendKind: "pi", draftPending: false }), runtimeModels: async () => [{ backend: { kind: "pi", label: "Pi" } }], notify: vi.fn() } as unknown as WorkbenchActions;
  render(<TestProviders><TestThreadStore projects={[{ path: "/project", name: "Tau", lastOpenedAt: 0 }]} threads={[thread("thread-1", "Cleanup thread"), thread("thread-2", "Other work"), thread("remote", "On Rex", { backendKind: "machine", machine: { id: "rex", name: "Rex" } })]}>
    {card ? <ScheduleProposal feed={feed} actions={actions} /> : <AutomationsPage actions={actions} params={{}} navigate={vi.fn()} close={vi.fn()} feed={feed} />}
  </TestThreadStore></TestProviders>);
  return { invoke };
}
async function newAutomation() {
  fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
  const dialog = await screen.findByRole("dialog", { name: "New automation" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Nightly" } });
  fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Continue" } });
  return dialog;
}

it("continues an existing local thread, offering only this machine's threads and starting from the active one", async () => {
  const h = setup();
  const dialog = await newAutomation();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Runs in" }), { target: { value: "thread" } });
  const picker = within(dialog).getByRole("combobox", { name: /^Thread/u }) as HTMLSelectElement;
  expect(picker.value).toBe("thread-1");
  expect([...picker.options].map((option) => option.textContent)).toEqual(["Select thread", "Cleanup thread · Tau", "Other work · Tau"]);
  expect(within(dialog).queryByRole("combobox", { name: /^Workspace/u })).toBeNull();
  fireEvent.change(picker, { target: { value: "thread-2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", expect.objectContaining({ name: "Nightly", target: { kind: "thread", threadId: "thread-2" } })));
});

it("picks a GitHub sender, shows its setup and saves the format and payload choice", async () => {
  const h = setup();
  const dialog = await newAutomation();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "When" }), { target: { value: "webhook" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Sender" }), { target: { value: "github" } });
  expect(within(dialog).getByText(/application\/json/u)).toBeTruthy();
  expect(within(dialog).getByText(/X-Hub-Signature-256/u)).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText(/^Webhook signature key/u), { target: { value: "github-secret-0123456789abcdefghij" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", expect.objectContaining({ schedule: { kind: "webhook", format: "github", includePayload: true, filters: [] } })));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("set-webhook-secret", { id: "job-1", value: "github-secret-0123456789abcdefghij" }));
});

it("explains Stripe's signing secret and holds a short shared secret back", async () => {
  setup();
  const dialog = await newAutomation();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "When" }), { target: { value: "webhook" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Sender" }), { target: { value: "stripe" } });
  expect(within(dialog).getAllByText(/whsec_/u).length).toBeGreaterThan(0);
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Sender" }), { target: { value: "bearer" } });
  fireEvent.change(within(dialog).getByLabelText(/^Webhook signature key/u), { target: { value: "too-short" } });
  expect(within(dialog).getByText("Use at least 32 characters, for example from openssl rand -hex 32.")).toBeTruthy();
  expect((within(dialog).getByRole("button", { name: "Save automation" }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows an agent's proposal to the owner and approves or declines it only through the owner commands", async () => {
  const h = setup({ scheduleRequests: [proposal] }, true);
  const card = await screen.findByRole("region", { name: "Automation proposal" });
  expect(within(card).getByText(/continues this thread/u)).toBeTruthy();
  expect(within(card).getByText(/Ask before edits/u)).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("approve-schedule", { id: "proposal-1", turnOn: false }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Automation proposal" })).toBeNull());
});

it("turns automations on with an approval when they are off, and paired devices cannot answer", async () => {
  const off = setup({ enabled: false, scheduleRequests: [proposal] }, true);
  fireEvent.click(await screen.findByRole("button", { name: "Turn on and approve" }));
  await waitFor(() => expect(off.invoke).toHaveBeenCalledWith("approve-schedule", { id: "proposal-1", turnOn: true }));
  cleanup();
  setup({ canManage: false, scheduleRequests: [proposal] }, true);
  expect((await screen.findByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Approve this in this machine's own Tau window.")).toBeTruthy();
});
