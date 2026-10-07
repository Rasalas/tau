// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostSnapshot, UiSession, UiToolRun, WorkbenchActions } from "tau";
import { WorkbenchContext } from "../../src/renderer/workbench-context.js";
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
  const view = (thread: string) => <TestProviders><TestThreadStore threads={sessions}><WorkbenchContext.Provider value={{ tools: [] } as never}><AgentLineage snapshot={{ sessionId: thread } as HostSnapshot} actions={actions} /></WorkbenchContext.Provider></TestThreadStore></TestProviders>;
  const result = render(view(id));
  return { actions, switchTo: (nextId: string) => result.rerender(view(nextId)) };
}
it("previews the child chat without switching the active thread", () => {
  agentsStore.set({ maxRunning: 8, links: [link] });
  const { actions, switchTo } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
  const row = screen.getByRole("button", { name: "Review layout, Completed" });
  expect(row.textContent).toBe("Review layout0:56");
  expect(row.querySelector(".agent-lineage-status svg")).toBeTruthy();
  fireEvent.click(row);
  expect(actions.switchSession).not.toHaveBeenCalled();
  expect(actions.openThread).toHaveBeenCalledWith("child");
  switchTo("child");
  expect(screen.queryByRole("button", { name: "Review layout, Completed" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
  expect(screen.getByRole("button", { name: "Review layout, Completed" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Back to Build the app" }));
  expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/parent");
});
it("retains navigation from indexed lineage without the live agents state", () => {
  const { actions } = setup("child");
  fireEvent.click(screen.getByRole("button", { name: "Back to Build the app" }));
  expect(actions.switchSession).toHaveBeenCalledWith("/sessions/parent");
  fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
  expect(screen.getByRole("button", { name: "Review layout, Idle" })).toBeTruthy();
});
it("folds previous agents and keeps a resumed agent visible with its new status", () => {
  agentsStore.set({ maxRunning: 8, links: [link] });
  setup();
  expect(screen.getByRole("button", { name: "Completed (1)" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Review layout, Completed" })).toBeNull();
  act(() => agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "waiting" }] }));
  expect(screen.getByRole("button", { name: "Review layout, Needs your answer" })).toBeTruthy();
});
it("disables a queued child without a thread and retains remote transcript access", () => {
  agentsStore.set({ maxRunning: 8, links: [{ ...link, id: "queued", threadId: undefined, title: "Queued", status: "pending" }, { ...link, id: "remote", threadId: undefined, title: "Remote", machine: { id: "rex", name: "Rex", thread: "remote-id" } }] });
  const { actions } = setup();
  expect(screen.getByRole("button", { name: "Queued, Queued" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Completed (2)" }));
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
  const actions = { switchSession: vi.fn(async () => true), openThread: vi.fn(), openPanel: vi.fn() } as unknown as WorkbenchActions;
  const tool = { id: "call", name: "tau_spawn_thread", args: {}, status: "done", output: JSON.stringify({ threadId: "child" }), startedAt: 1000, endedAt: 2000 } as UiToolRun;
  render(<TestProviders><TestThreadStore threads={sessions}><SpawnCard tools={[tool]} actions={actions} /></TestThreadStore></TestProviders>);
  fireEvent.click(screen.getByRole("button", { name: /Show agents/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review layout, Completed" }));
  expect(actions.switchSession).not.toHaveBeenCalled();
  expect(actions.openThread).toHaveBeenCalledWith("child");
  expect(actions.openPanel).not.toHaveBeenCalled();
});

it("moves a finished agent into the collapsed completed group while keeping a manual expansion", () => {
  agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "running" }] });
  setup();
  expect(screen.getByRole("button", { name: "Review layout, Running" })).toBeTruthy();
  act(() => agentsStore.set({ maxRunning: 8, links: [link] }));
  expect(screen.queryByRole("button", { name: "Review layout, Completed" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
  act(() => agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "failed" }] }));
  expect(screen.getByRole("button", { name: "Review layout, Failed" })).toBeTruthy();
});

it("expands a native child's transcript inside the parent, without any thread navigation", () => {
  const actions = { switchSession: vi.fn(), openThread: vi.fn() } as unknown as WorkbenchActions;
  const tool = { id: "native-agent:codex:child", kind: "subagent", name: "tau_native_subagent", args: { agentId: "child", runtime: "codex", title: "Native reviewer", model: "gpt-5.6-luna", agentStatus: "completed" }, status: "done", output: "Native answer", startedAt: 1000, endedAt: 2000 } as UiToolRun;
  render(<TestProviders><TestThreadStore threads={sessions}><WorkbenchContext.Provider value={{ tools: [tool] } as never}><AgentLineage snapshot={{ sessionId: "parent" } as HostSnapshot} actions={actions} /></WorkbenchContext.Provider></TestThreadStore></TestProviders>);
  fireEvent.click(screen.getByRole("button", { name: "Native reviewer, Completed" }));
  expect(screen.getByRole("region", { name: "Native reviewer transcript" }).textContent).toContain("Native answer");
  expect(actions.switchSession).not.toHaveBeenCalled();
  expect(actions.openThread).not.toHaveBeenCalled();
});
