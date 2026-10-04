// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import type { PullRequestCheck } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { StripRequest } from "./pull-request-strip-logic.js";
import { WorkspaceRequestChecks } from "./workspace-request-checks.js";

const request: StripRequest = { url: "https://github.com/acme/app/pull/12", service: "github", number: 12, state: "open" };
const passed: PullRequestCheck[] = [{ name: "PHP tests", workflow: "CI", status: "passed", url: "https://github.com/acme/app/actions/runs/123/job/4" }, { name: "Frontend checks", workflow: "CI", status: "passed" }];

it("does not mark unknown or entirely skipped aggregate checks as passing", () => {
  render(<WorkspaceRequestChecks request={{ ...request, checks: { total: 2, passed: 0, failed: 0, pending: 0 } }} actions={{} as WorkbenchActions} details={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Pull request checks, 0/2 passed" });
  expect(trigger.classList.contains("checks-passing")).toBe(false);
});

it("replaces cached passing status with an error after a failed checks lookup", async () => {
  const client = { checks: vi.fn(async () => { throw new Error("Host offline"); }) } as unknown as PullRequestClient;
  render(<WorkspaceRequestChecks request={{ ...request, checks: { total: 2, passed: 2, failed: 0, pending: 0 } }} client={client} actions={{} as WorkbenchActions} details={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull request checks, 2/2 passed" }));
  await screen.findByRole("alert");
  const trigger = screen.getByRole("button", { name: "Pull request checks, Checks unavailable" });
  expect(trigger.classList.contains("checks-passing")).toBe(false);
  expect(trigger.classList.contains("checks-error")).toBe(true);
  expect(trigger.title).toBe("Host offline");
});

it("loads checks only on opening, reuses the vertical pipeline view and opens real details", async () => {
  const checks = vi.fn(async () => passed);
  const client = { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient;
  const actions = { openExternal: vi.fn() } as unknown as WorkbenchActions;
  const details = vi.fn();
  render(<WorkspaceRequestChecks request={request} client={client} actions={actions} details={details} />);
  expect(checks).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Pull request checks, Checks" }).classList.contains("checks-passing")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Pull request checks, Checks" }));
  await screen.findByRole("button", { name: "Details for PHP tests" });
  expect(document.querySelector(".pl-vertical")).toBeTruthy();
  expect(screen.getByText("Frontend checks")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pull request checks, All checks passed" }).classList.contains("checks-passing")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Details for PHP tests" }));
  expect(actions.openExternal).toHaveBeenCalledWith(passed[0]!.url);
  fireEvent.click(screen.getByRole("button", { name: "View all checks" }));
  expect(details).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows loading, empty checks and lookup errors without claiming a pass", async () => {
  let finish!: (checks: PullRequestCheck[]) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error("Checks unavailable"));
  render(<WorkspaceRequestChecks request={request} client={{ checks: read } as unknown as PullRequestClient} actions={{} as WorkbenchActions} details={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull request checks, Checks" }));
  expect(screen.getByRole("status").textContent).toBe("Loading checks…");
  await act(async () => { finish([]); });
  expect(screen.getByRole("status").textContent).toBe("No checks reported.");
  expect(screen.getByRole("button", { name: "Pull request checks, No checks reported" }).classList.contains("checks-passing")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Refresh checks" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("Checks unavailable");
  expect(screen.getByRole("button", { name: "Pull request checks, Checks unavailable" }).classList.contains("checks-passing")).toBe(false);
});

it("discards late check results from an earlier request", async () => {
  let finish!: (checks: PullRequestCheck[]) => void;
  const checks = vi.fn(() => new Promise<PullRequestCheck[]>((resolve) => { finish = resolve; }));
  const client = { checks } as unknown as PullRequestClient;
  const view = render(<WorkspaceRequestChecks request={request} client={client} actions={{} as WorkbenchActions} details={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull request checks, Checks" }));
  view.rerender(<WorkspaceRequestChecks request={{ ...request, url: "https://github.com/acme/app/pull/13", number: 13 }} client={client} actions={{} as WorkbenchActions} details={vi.fn()} />);
  await act(async () => { finish(passed); });
  expect(screen.queryByText("PHP tests")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Pull request checks, Checks" }).getAttribute("aria-expanded")).toBe("false"));
});

it("refreshes a failed pipeline while another job is still running", async () => {
  vi.useFakeTimers();
  try {
    const checks = vi.fn().mockResolvedValueOnce([{ name: "lint", status: "failed" }, { name: "smoke", status: "pending" }]).mockResolvedValue([{ name: "lint", status: "passed" }, { name: "smoke", status: "passed" }]);
    const view = render(<WorkspaceRequestChecks request={{ ...request, url: `${request.url}4` }} client={{ checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient} actions={{} as WorkbenchActions} details={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull request checks, Checks" }));
    await act(async () => undefined);
    expect(checks).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(checks).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Pull request checks, All checks passed" })).toBeTruthy();
    view.unmount();
  } finally { vi.useRealTimers(); }
});

it("does not fetch unfinished checks while the window stays hidden", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    const checks = vi.fn(async () => [{ name: "smoke", status: "pending" }]);
    const view = render(<WorkspaceRequestChecks request={{ ...request, url: `${request.url}5` }} client={{ checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient} actions={{} as WorkbenchActions} details={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull request checks, Checks" }));
    await act(async () => undefined);
    visibility.mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(checks).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(checks).toHaveBeenCalledTimes(2);
    view.unmount();
  } finally { visibility.mockRestore(); vi.useRealTimers(); }
});

it("uses refreshed request counts after a failed checks popover was closed", async () => {
  const client = { checks: vi.fn(async () => [{ name: "CI", status: "failed" }]), pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient;
  const failed = { ...request, url: `${request.url}6`, checks: { passed: 0, failed: 1, pending: 0, total: 1 } };
  const view = render(<WorkspaceRequestChecks request={failed} client={client} actions={{} as WorkbenchActions} details={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull request checks, 1 failing" }));
  const trigger = await screen.findByRole("button", { name: "Pull request checks, 1 of 1 failing" });
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  view.rerender(<WorkspaceRequestChecks request={{ ...failed, state: "merged", checks: { passed: 1, failed: 0, pending: 0, total: 1 } }} client={client} actions={{} as WorkbenchActions} details={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Pull request checks, 1/1 passed" }).classList.contains("checks-passing")).toBe(true);
  expect(client.checks).toHaveBeenCalledTimes(1);
});
