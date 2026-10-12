// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopExtension, HostExtensionClient, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import schedulingExtension from "./desktop.js";
import { SchedulingFeed } from "./feed.js";
import type { Job, ManagementState } from "./protocol.js";
import AutomationsSummary, { type WorkspaceSummaryService } from "./summary.js";

afterEach(cleanup);
const job: Job = { id: "job-1", workspaceId: "host:/project", enabled: true, status: "ready", nextAt: "2026-10-14T09:00:00Z", config: { name: "Check triage of open issues", workspace: "/project", backend: "pi", prompt: "Inspect issues", schedule: { kind: "daily", time: "09:00", timezone: "UTC" } } };
function setup(patch: Partial<ManagementState> = {}, failure?: string, initialProject = "/project") {
  let state: ManagementState = { enabled: true, canManage: true, jobs: [structuredClone(job)], secretRequests: [], ...patch };
  const invoke = vi.fn(async (command: string) => {
    if (command === "manage") return structuredClone(state);
    if (failure) throw new Error(failure);
    if (command === "enable" || command === "disable") state = { ...state, jobs: state.jobs.map((entry) => ({ ...entry, enabled: command === "enable" })) };
  });
  const feed = new SchedulingFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient);
  const actions = { openPage: vi.fn() } as unknown as WorkbenchActions;
  let followed: ReturnType<WorkspaceSummaryService["getSnapshot"]> = { cwd: initialProject };
  const listeners = new Set<() => void>();
  const workspace: WorkspaceSummaryService = { getSnapshot: () => followed, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  render(<AutomationsSummary actions={actions} feed={feed} workspace={workspace} />);
  return { invoke, actions, follow: (next: typeof followed) => act(() => { followed = next; for (const listener of listeners) listener(); }) };
}

it("registers at the bottom of the project card and removes the contribution on deactivation", () => {
  const { registry } = createKitHarness();
  const release = vi.fn();
  const register = vi.fn(() => release);
  const workspace: DesktopExtension = { id: "test.workspace", name: "Workspace", activate: (plugin) => { plugin.provideService("tau.workspace/store", { registerWorkspaceSummarySection: register }); } };
  registry.activate(workspace);
  registry.activate(schedulingExtension);
  expect(register).toHaveBeenCalledWith(expect.any(Function), "footer");
  expect(registry.getSidebarContributions()).toEqual([]);
  registry.deactivate(schedulingExtension.id);
  expect(release).toHaveBeenCalled();
});

it("follows the shown project and includes its main checkout's automations in a worktree", async () => {
  const other = { ...job, id: "job-2", workspaceId: "host:/other", config: { ...job.config, name: "Other project's job", workspace: "/other" } };
  const h = setup({ jobs: [job, other] });
  expect(await screen.findByText(job.config.name)).toBeTruthy();
  expect(screen.queryByText(other.config.name)).toBeNull();
  h.follow({ cwd: "/other" });
  expect(await screen.findByText(other.config.name)).toBeTruthy();
  expect(screen.queryByText(job.config.name)).toBeNull();
  h.follow({ cwd: "/worktrees/feature", workspace: { root: "/worktrees/feature", worktrees: [{ path: "/project", isMain: true }] } });
  expect(await screen.findByText(job.config.name)).toBeTruthy();
  expect(screen.queryByText(other.config.name)).toBeNull();
});

it("offers edit, manual run and a working switch directly in the project status card", async () => {
  const h = setup();
  expect(await screen.findByText(/^Daily at 09:00 UTC/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Edit ${job.config.name}` }));
  expect(h.actions.openPage).toHaveBeenCalledWith("scheduling.automations", { edit: "job-1" });
  fireEvent.click(screen.getByRole("button", { name: `Run ${job.config.name} now` }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("run", { id: "job-1" }));
  const toggle = screen.getByRole("switch", { name: `Turn off ${job.config.name}` });
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("disable", { id: "job-1" }));
  expect((await screen.findByRole("switch", { name: `Turn on ${job.config.name}` })).getAttribute("aria-checked")).toBe("false");
  expect(await screen.findByText("Off")).toBeTruthy();
});

it.each(["held", "failed", "uncertain", "starting", "running"] as const)("routes %s jobs to the management page without starting or changing them", async (status) => {
  const h = setup({ jobs: [{ ...job, status }] });
  const view = await screen.findByRole("button", { name: `View ${job.config.name}` });
  expect((screen.getByRole("button", { name: `Edit ${job.config.name}` }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: `Run ${job.config.name} now` }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view);
  expect(h.actions.openPage).toHaveBeenCalledWith("scheduling.automations");
  expect(h.invoke.mock.calls.every(([command]) => command === "manage")).toBe(true);
});

it("keeps management available on a paired device and disables mutations", async () => {
  const h = setup({ canManage: false });
  await screen.findByText(job.config.name);
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: `Run ${job.config.name} now` }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: `Edit ${job.config.name}` }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Manage automations" }));
  expect(h.actions.openPage).toHaveBeenCalledWith("scheduling.automations");
});

it("does not run jobs while automations are globally off", async () => {
  setup({ enabled: false });
  expect(await screen.findByText("Automations off")).toBeTruthy();
  expect((screen.getByRole("button", { name: `Run ${job.config.name} now` }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows host errors on the row and restores its controls", async () => {
  setup({}, "Could not start this automation");
  fireEvent.click(await screen.findByRole("button", { name: `Run ${job.config.name} now` }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not start this automation");
  await waitFor(() => expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false));
});
