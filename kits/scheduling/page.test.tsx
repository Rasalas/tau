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
const job: Job = { id: "job-1", workspaceId: "host:/project", enabled: true, status: "ready", nextAt: "2026-10-08T09:00:00Z", config: { name: "Morning digest", workspace: "/project", backend: "pi", prompt: "Inspect CI", schedule: { kind: "daily", time: "09:00", timezone: "UTC" } } };
function setup(patch: Partial<ManagementState> = {}, privateCard = false) {
  let state: ManagementState = { enabled: true, jobs: [structuredClone(job)], canManage: true, secretRequests: [], ...patch };
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
  render(<TestProviders><TestThreadStore projects={[{ path: "/project", name: "Tau", lastOpenedAt: 0 }]} threads={[]}>
    {privateCard ? <><div className="composer-frame"><textarea defaultValue="Unsent draft" aria-label="Composer" /></div><PrivateSecret feed={feed} actions={actions} /></> : <AutomationsPage actions={actions} params={{}} navigate={vi.fn()} close={vi.fn()} feed={feed} />}
  </TestThreadStore></TestProviders>);
  return { invoke, actions };
}

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
  expect(screen.getByText(/Manage them in this host's own Tau window/)).toBeTruthy();
});

it("creates and enables from one form with the current thread's project and runtime", async () => {
  const h = setup({ jobs: [] });
  fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
  const dialog = await screen.findByRole("dialog", { name: "New automation" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Daily review" } });
  fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "Inspect changes" } });
  expect((within(dialog).getByLabelText("Project") as HTMLSelectElement).value).toBe("/project");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save automation" }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("create", { name: "Daily review", prompt: "Inspect changes", workspace: "/project", backend: "pi", schedule: { kind: "daily", time: "09:00", timezone: "UTC" } }));
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
