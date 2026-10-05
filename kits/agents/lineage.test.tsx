// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostSnapshot, UiSession, UiToolRun, WorkbenchActions } from "tau";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { SpawnCard } from "./spawn-card.js";
import { agentsExtension } from "./desktop.js";
import { AgentLineage } from "./lineage.js";
import { agentsStore } from "./store.js";
import type { AgentThreadLink } from "./protocol.js";

const sessions: UiSession[] = [
  { id: "parent", title: "Build the app", path: "/sessions/parent", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 2 },
  { id: "child", title: "Review layout", path: "/sessions/child", parentThreadId: "parent", modifiedAt: 2, projectPath: "/project", projectName: "project", messageCount: 2, modelProvider: "openai" },
];
const link: AgentThreadLink = { id: "child", threadId: "child", parentThreadId: "parent", title: "Review layout", status: "completed", spawnedBy: "tau_spawn_thread", spawnedAt: 1000, startedAt: 1000, endedAt: 57000, projectPath: "/project", depth: 1 };
afterEach(() => agentsStore.clear());
function setup(id = "parent") {
  const actions = { switchSession: vi.fn(async () => true), openThread: vi.fn() } as unknown as WorkbenchActions;
  const view = (thread: string) => <TestProviders><TestThreadStore threads={sessions}><AgentLineage snapshot={{ sessionId: thread } as HostSnapshot} actions={actions} /></TestThreadStore></TestProviders>;
  const result = render(view(id));
  return { actions, switchTo: (nextId: string) => result.rerender(view(nextId)) };
}
it("opens the child chat and provides the return trip in the same card", () => {
  agentsStore.set({ maxRunning: 8, links: [link] });
  const { actions, switchTo } = setup();
  const row = screen.getByRole("button", { name: "Review layout, Completed" });
  expect(row.textContent).toBe("Review layout0:56");
  expect(row.querySelector(".agent-lineage-status svg")).toBeTruthy();
  fireEvent.click(row);
  expect(actions.switchSession).toHaveBeenCalledWith("/sessions/child");
  expect(actions.openThread).not.toHaveBeenCalled();
  switchTo("child");
  expect(screen.getByRole("button", { name: "Review layout, Completed" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Back to Build the app" }));
  expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/parent");
});
it("retains navigation from indexed lineage without the live agents state", () => {
  const { actions } = setup("child");
  fireEvent.click(screen.getByRole("button", { name: "Back to Build the app" }));
  expect(actions.switchSession).toHaveBeenCalledWith("/sessions/parent");
  expect(screen.getByRole("button", { name: "Review layout, Idle" })).toBeTruthy();
});
it("folds previous agents and keeps a resumed agent visible with its new status", () => {
  agentsStore.set({ maxRunning: 8, links: [link] });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Previous agents" }));
  expect(screen.queryByRole("button", { name: "Review layout, Completed" })).toBeNull();
  act(() => agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "waiting" }] }));
  expect(screen.getByRole("button", { name: "Review layout, Needs your answer" })).toBeTruthy();
});
it("disables a queued child without a thread and retains remote transcript access", () => {
  agentsStore.set({ maxRunning: 8, links: [{ ...link, id: "queued", threadId: undefined, title: "Queued", status: "pending" }, { ...link, id: "remote", threadId: undefined, title: "Remote", machine: { id: "rex", name: "Rex", thread: "remote-id" } }] });
  const { actions } = setup();
  expect(screen.getByRole("button", { name: "Queued, Queued" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remote, Completed" }));
  expect(actions.openThread).toHaveBeenCalledWith("remote-id", { machine: "rex" });
});
it("contributes lineage after Changes and no longer registers an Agents panel", () => {
  const { registry } = createKitHarness();
  const release = vi.fn();
  const register = vi.fn(() => release);
  registry.activate({ id: "test.workspace", name: "Workspace", activate: (context) => { context.provideService("tau.workspace/store", { registerWorkspaceSummarySection: register }); } });
  registry.activate(agentsExtension);
  expect(register).toHaveBeenCalledWith(AgentLineage, "footer");
  expect(registry.getPanels().some((panel) => panel.id === "agents")).toBe(false);
  registry.deactivate(agentsExtension.id);
  expect(release).toHaveBeenCalled();
});

it("expands the spawn card into chat links without opening the removed panel", () => {
  agentsStore.set({ maxRunning: 8, links: [link] });
  const actions = { switchSession: vi.fn(async () => true), openPanel: vi.fn() } as unknown as WorkbenchActions;
  const tool = { id: "call", name: "tau_spawn_thread", args: {}, status: "done", output: JSON.stringify({ threadId: "child" }), startedAt: 1000, endedAt: 2000 } as UiToolRun;
  render(<TestProviders><TestThreadStore threads={sessions}><SpawnCard tools={[tool]} actions={actions} /></TestThreadStore></TestProviders>);
  fireEvent.click(screen.getByRole("button", { name: /Show agents/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review layout, Completed" }));
  expect(actions.switchSession).toHaveBeenCalledWith("/sessions/child");
  expect(actions.openPanel).not.toHaveBeenCalled();
});
