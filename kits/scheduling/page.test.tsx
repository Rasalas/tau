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

it("creates a repeating automation in local time and shows an existing one with its sentence", async () => {
  const repeating = { ...job, config: { ...job.config, schedule: { kind: "cron" as const, expression: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } } };
  const h = setup({ jobs: [repeating] });
  expect(await screen.findByText(/Every weekday at 09:00/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New automation" }));
  const dialog = await screen.findByRole("dialog", { name: "New automation" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Monthly report" } });
  fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Summarize" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "When" }), { target: { value: "cron" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Repeat every" }), { target: { value: "month" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Day of month" }), { target: { value: "15" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", expect.objectContaining({ name: "Monthly report", schedule: { kind: "cron", expression: "0 9 15 * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New automation" })).toBeNull());
});

it("creates typed payload filters through the webhook editor", async () => {
  const h = setup({ jobs: [], secretStore: "Test OS store" });
  fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
  const dialog = await screen.findByRole("dialog", { name: "New automation" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "CI webhook" } });
  fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Inspect CI" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "When" }), { target: { value: "webhook" } });
  fireEvent.change(within(dialog).getByLabelText(/Webhook signature key/u), { target: { value: "private-key-0123456789-0123456789-0123456789" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add payload filter" }));
  fireEvent.change(within(dialog).getByLabelText("Payload path 1"), { target: { value: "action" } });
  fireEvent.change(within(dialog).getByLabelText("Expected value 1"), { target: { value: "completed" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add payload filter" }));
  fireEvent.change(within(dialog).getByLabelText("Payload path 2"), { target: { value: "check.number" } });
  fireEvent.change(within(dialog).getByLabelText("Value type 2"), { target: { value: "number" } });
  fireEvent.change(within(dialog).getByLabelText("Expected value 2"), { target: { value: "7" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add payload filter" }));
  fireEvent.change(within(dialog).getByLabelText("Payload path 3"), { target: { value: "check.detail" } });
  fireEvent.change(within(dialog).getByLabelText("Condition 3"), { target: { value: "exists" } });
  expect(within(dialog).queryByLabelText("Expected value 3")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", expect.objectContaining({ schedule: { kind: "webhook", includePayload: true, filters: [{ path: "action", op: "equals", value: "completed" }, { path: "check.number", op: "equals", value: 7 }, { path: "check.detail", op: "exists" }] } })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New automation" })).toBeNull());
  expect(h.invoke).toHaveBeenCalledWith("set-webhook-secret", { id: "job-1", value: "private-key-0123456789-0123456789-0123456789" });
  expect(h.invoke).toHaveBeenCalledWith("enable", { id: "job-1" });
});

it("round-trips saved JSON scalar types and explicitly clears removed filters", async () => {
  const filters = [
    { path: "check.success", op: "equals" as const, value: false },
    { path: "check.detail", op: "equals" as const, value: null },
    { path: "check.title", op: "equals" as const, value: "" },
  ];
  const webhook = { ...job, secretRef: "saved-key", config: { ...job.config, schedule: { kind: "webhook" as const, filters } } };
  const h = setup({ jobs: [webhook], secretStore: "Test OS store" }, false, { edit: "job-1" });
  const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
  expect(await screen.findByText(/Signed webhook · 3 payload filters/u)).toBeTruthy();
  expect((within(dialog).getByLabelText("Expected value 1") as HTMLSelectElement).value).toBe("false");
  expect((within(dialog).getByLabelText("Value type 2") as HTMLSelectElement).value).toBe("null");
  expect((within(dialog).getByLabelText("Expected value 3") as HTMLInputElement).value).toBe("");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("update", expect.objectContaining({ config: expect.objectContaining({ schedule: { kind: "webhook", filters } }) })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
  h.reopen();
  const reopened = await screen.findByRole("dialog", { name: "Edit automation" });
  for (let index = 0; index < filters.length; index++) fireEvent.click(within(reopened).getByRole("button", { name: "Remove filter 1" }));
  fireEvent.click(within(reopened).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("update", expect.objectContaining({ config: expect.objectContaining({ schedule: { kind: "webhook", filters: [] } }) })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
});

it("rejects unsupported filter paths before saving any webhook configuration", async () => {
  const webhook = { ...job, secretRef: "saved-key", config: { ...job.config, schedule: { kind: "webhook" as const } } };
  const h = setup({ jobs: [webhook], secretStore: "Test OS store" }, false, { edit: "job-1" });
  const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add payload filter" }));
  fireEvent.change(within(dialog).getByLabelText("Payload path 1"), { target: { value: "labels[nope].name" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  const field = within(dialog).getByLabelText("Payload path 1");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toContain("Use names");
  expect(h.invoke.mock.calls.some(([command]) => command === "update" || command === "create")).toBe(false);
});

it("checks wildcard rules locally against an unsaved sample and shows inline path errors", async () => {
  const webhook = { ...job, secretRef: "saved-key", config: { ...job.config, schedule: { kind: "webhook" as const, filters: [{ path: "labels[].name", op: "equals" as const, value: "bug" }] } } };
  const h = setup({ jobs: [webhook], secretStore: "Test OS store" }, false, { edit: "job-1" });
  const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
  const sampleSection = within(dialog).getByText("Check against a sample payload").closest("details")!;
  expect(sampleSection.open).toBe(false);
  fireEvent.click(within(dialog).getByText("Check against a sample payload"));
  const before = h.invoke.mock.calls.length;
  const sample = within(dialog).getByLabelText("Sample JSON (not saved)");
  fireEvent.change(sample, { target: { value: '{"labels":[{"name":"bug"}],"private":"sample-private"}' } });
  expect(await within(dialog).findByText("Rule 1: Matches")).toBeTruthy();
  expect(within(dialog).getByText("This delivery would start a run.")).toBeTruthy();
  fireEvent.change(sample, { target: { value: '{"labels":[]}' } });
  expect(within(dialog).getByText("Rule 1: Doesn't match")).toBeTruthy();
  expect(within(dialog).getByText("This delivery would be ignored.")).toBeTruthy();
  fireEvent.change(sample, { target: { value: "broken" } });
  expect(within(dialog).getByText("Not valid JSON.")).toBeTruthy();
  expect(h.invoke.mock.calls).toHaveLength(before);
  fireEvent.change(within(dialog).getByLabelText("Payload path 1"), { target: { value: "labels[0].name" } });
  expect(within(dialog).getByText("Use names, numbers or [] separated by dots, such as issue.labels[].name.")).toBeTruthy();
  expect((within(dialog).getByRole("button", { name: "Save automation" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Payload path 1"), { target: { value: "labels[].name" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("update", expect.objectContaining({ config: expect.objectContaining({ schedule: webhook.config.schedule }) })));
  expect(JSON.stringify(h.invoke.mock.calls)).not.toContain("sample-private");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
});

it("loads and saves burst settings and explicitly clears combining", async () => {
  const schedule = { kind: "webhook" as const, filters: [], coalescing: { keyPath: "pull_request.number", waitSeconds: 120 } };
  const webhook = { ...job, secretRef: "saved-key", config: { ...job.config, schedule } };
  const h = setup({ jobs: [webhook], secretStore: "Test OS store" }, false, { edit: "job-1" });
  const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
  expect(await screen.findByText(/Signed webhook · combines bursts \(2 min\)/u)).toBeTruthy();
  expect((within(dialog).getByLabelText("Deliveries") as HTMLSelectElement).value).toBe("combine");
  expect((within(dialog).getByLabelText("Key path") as HTMLInputElement).value).toBe("pull_request.number");
  fireEvent.change(within(dialog).getByLabelText("Wait in seconds"), { target: { value: "10" } });
  fireEvent.change(within(dialog).getByLabelText("Key path"), { target: { value: "issue.id" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("update", expect.objectContaining({ config: expect.objectContaining({ schedule: { ...schedule, coalescing: { keyPath: "issue.id", waitSeconds: 10 } } }) })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
  h.reopen();
  const reopened = await screen.findByRole("dialog", { name: "Edit automation" });
  fireEvent.change(within(reopened).getByLabelText("Deliveries"), { target: { value: "each" } });
  expect(within(reopened).queryByLabelText("Key path")).toBeNull();
  fireEvent.click(within(reopened).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("update", expect.objectContaining({ config: expect.objectContaining({ schedule: { kind: "webhook", filters: [], coalescing: null } }) })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
});

it("keeps waiting metadata visible without a live region and turns off pending work explicitly from the editor", async () => {
  const schedule = { kind: "webhook" as const, coalescing: { keyPath: "issue.id", waitSeconds: 120 } };
  const webhook = { ...job, nextAt: undefined, secretRef: "saved-key", config: { ...job.config, schedule }, webhookBursts: [{ id: "window", at: new Date().toISOString(), dueAt: new Date(Date.now() + 120_000).toISOString(), count: 3 }] };
  const h = setup({ jobs: [webhook], secretStore: "Test OS store" }, false, { edit: "job-1" });
  const waiting = await screen.findByText(/Combining 3 deliveries · starts in/u);
  expect(waiting.getAttribute("aria-live")).toBe("off");
  const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Start on signed delivery" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("disable", { id: "job-1" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull());
});
