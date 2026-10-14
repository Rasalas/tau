// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionClient, HostSnapshot } from "tau";
import { ClientStorageProvider, createMemoryStorage } from "../../src/renderer/test-support/kit-harness.js";
import { SchedulingFeed } from "./feed.js";
import RepeatPlanner, { plannedName, REPEAT_LAST_KEY } from "./planner.js";
import type { Job, ManagementState } from "./protocol.js";

afterEach(cleanup);
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function setup({ patch = {}, attachments = 0, storage = createMemoryStorage(), text = "Check the nightly build\nand report failures" }: { patch?: Partial<ManagementState>; attachments?: number; storage?: ReturnType<typeof createMemoryStorage>; text?: string } = {}) {
  let state: ManagementState = { enabled: true, jobs: [], canManage: true, defaultAccessLevel: "full", secretRequests: [], ...patch };
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "manage") return structuredClone(state);
    if (command === "create") { const job = { id: "job-1", config: input, enabled: false, status: "ready", workspaceId: "host:/project" } as Job; state = { ...state, jobs: [job] }; return job; }
    if (command === "set-enabled") state = { ...state, enabled: (input as { enabled: boolean }).enabled };
    return undefined;
  });
  const feed = new SchedulingFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient);
  const onPlanned = vi.fn();
  const snapshot = { cwd: "/project", backendKind: "codex", sessionId: "thread-1" } as HostSnapshot;
  render(<ClientStorageProvider storage={storage}><RepeatPlanner draft={{ text, attachments }} snapshot={snapshot} actions={undefined} onPlanned={onPlanned} onCancel={vi.fn()} feed={feed} /></ClientStorageProvider>);
  return { invoke, onPlanned, storage };
}
const enabled = async (name: string) => {
  const button = await screen.findByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};

it("builds a weekly Monday, Wednesday and Friday schedule, creates and enables it, and remembers it", async () => {
  const h = setup();
  fireEvent.change(screen.getByRole("combobox", { name: "Repeat every" }), { target: { value: "week" } });
  const days = screen.getByRole("group", { name: "Days" });
  // A week starts on weekdays; drop Tuesday and Thursday.
  fireEvent.click(within(days).getByRole("button", { name: "Tuesday" }));
  fireEvent.click(within(days).getByRole("button", { name: "Thursday" }));
  expect(within(days).getByRole("button", { name: "Monday" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(days).getByRole("button", { name: "Tuesday" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText("0 9 * * 1,3,5")).toBeTruthy();
  expect(screen.getByText(/^Next /u)).toBeTruthy();
  expect(screen.getByText("Each run in a new thread")).toBeTruthy();
  fireEvent.click(await enabled("Plan"));
  await waitFor(() => expect(h.onPlanned).toHaveBeenCalledWith("Every Monday, Wednesday and Friday at 09:00"));
  expect(h.invoke).toHaveBeenCalledWith("create", { name: "Check the nightly build", workspace: "/project", backend: "codex", prompt: "Check the nightly build\nand report failures", schedule: { kind: "cron", expression: "0 9 * * 1,3,5", timezone }, workspaceStrategy: "worktree", maxDurationMinutes: 60 });
  expect(h.invoke).toHaveBeenCalledWith("enable", { id: "job-1" });
  expect(h.invoke).not.toHaveBeenCalledWith("set-enabled", expect.anything());
  expect(h.storage.get(REPEAT_LAST_KEY)).toBe("0 9 * * 1,3,5");
  cleanup();
  setup({ storage: h.storage });
  expect((screen.getByRole("combobox", { name: "Repeat every" }) as HTMLSelectElement).value).toBe("week");
  expect(within(screen.getByRole("group", { name: "Days" })).getByRole("button", { name: "Wednesday" }).getAttribute("aria-pressed")).toBe("true");
});

it("turns automations on with the plan when they are off", async () => {
  const h = setup({ patch: { enabled: false } });
  expect(await screen.findByText("Automations are off. Planning turns them on.")).toBeTruthy();
  fireEvent.click(await enabled("Turn on and plan"));
  await waitFor(() => expect(h.onPlanned).toHaveBeenCalledWith("Every day at 09:00"));
  expect(h.invoke.mock.calls.map(([command]) => command).filter((command) => command !== "manage")).toEqual(["create", "enable", "set-enabled"]);
  expect(h.invoke).toHaveBeenCalledWith("set-enabled", { enabled: true });
});

it("explains a paired device and attachments, and keeps Plan off", async () => {
  setup({ patch: { canManage: false }, attachments: 2 });
  expect(await screen.findByText(/This device can't manage automations/u)).toBeTruthy();
  expect(screen.getByText("Attachments stay with this thread; the automation gets the text only.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Plan" }) as HTMLButtonElement).disabled).toBe(true);
});

it("reads a hand-written expression as Custom and refuses an invalid one", async () => {
  const h = setup();
  await enabled("Plan");
  const field = screen.getByRole("textbox", { name: "Cron expression" });
  fireEvent.change(field, { target: { value: "*/20 9-17 * * 1-5" } });
  expect((screen.getByRole("combobox", { name: "Repeat every" }) as HTMLSelectElement).value).toBe("custom");
  expect(screen.getAllByText("*/20 9-17 * * 1-5").length).toBeGreaterThan(0);
  fireEvent.change(field, { target: { value: "0 9 * * 8" } });
  expect((await screen.findByRole("alert")).textContent).toMatch(/day of week field "8"/u);
  expect((screen.getByRole("button", { name: "Plan" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "0 9 * * 1-5" } });
  expect((screen.getByRole("combobox", { name: "Repeat every" }) as HTMLSelectElement).value).toBe("week");
  fireEvent.click(await enabled("Plan"));
  await waitFor(() => expect(h.onPlanned).toHaveBeenCalledWith("Every weekday at 09:00"));
});

it("names the automation after the draft's first line", () => {
  expect(plannedName("\n  Review open PRs  \nthen more")).toBe("Review open PRs");
  expect(plannedName("   ")).toBe("Planned message");
  expect(plannedName("x".repeat(80))).toHaveLength(60);
});
