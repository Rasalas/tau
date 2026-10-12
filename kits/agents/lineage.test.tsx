// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostSnapshot, UiSession, UiToolRun, WorkbenchActions } from "tau";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { WorkbenchContext, createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { SpawnCard } from "./spawn-card.js";
import { agentsExtension } from "./desktop.js";
import { AgentQuestionsBanner } from "./banner.js";
import { AgentLineage } from "./lineage.js";
import { SUBAGENT_VIEW } from "./subagent-view.js";
import { agentsHost, agentsStore } from "./store.js";
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
  fireEvent.click(screen.getByRole("button", { name: "Previous agents (1)" }));
  const row = screen.getByRole("button", { name: "Review layout, Completed" });
  expect(row.textContent).toBe("Review layout0:56");
  expect(row.querySelector(".agent-lineage-status svg")).toBeTruthy();
  fireEvent.click(row);
  expect(actions.switchSession).not.toHaveBeenCalled();
  expect(actions.openThread).toHaveBeenCalledWith("child");
  switchTo("child");
  expect(screen.queryByRole("button", { name: "Review layout, Completed" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Previous agents (1)" }));
  expect(screen.getByRole("button", { name: "Review layout, Completed" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Back to Build the app" }));
  expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/parent");
});
it("retains navigation from indexed lineage without the live agents state", () => {
  const { actions } = setup("child");
  fireEvent.click(screen.getByRole("button", { name: "Back to Build the app" }));
  expect(actions.switchSession).toHaveBeenCalledWith("/sessions/parent");
  fireEvent.click(screen.getByRole("button", { name: "Previous agents (1)" }));
  expect(screen.getByRole("button", { name: "Review layout, Idle" })).toBeTruthy();
});
it("folds previous agents and keeps a resumed agent visible with its new status", () => {
  agentsStore.set({ maxRunning: 8, links: [link] });
  setup();
  expect(screen.getByRole("button", { name: "Previous agents (1)" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Review layout, Completed" })).toBeNull();
  act(() => agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "waiting" }] }));
  expect(screen.getByRole("button", { name: "Review layout, Needs your answer" })).toBeTruthy();
});
it("disables a queued child without a thread and retains remote transcript access", () => {
  agentsStore.set({ maxRunning: 8, links: [{ ...link, id: "queued", threadId: undefined, title: "Queued", status: "pending" }, { ...link, id: "remote", threadId: undefined, title: "Remote", machine: { id: "rex", name: "Rex", thread: "remote-id" } }] });
  const { actions } = setup();
  expect(screen.getByRole("button", { name: "Queued, Queued" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous agents (2)" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Previous agents (1)" }));
  act(() => agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "failed" }] }));
  expect(screen.getByRole("button", { name: "Review layout, Failed" })).toBeTruthy();
});

it("opens a native child in place of the parent's transcript, without any thread navigation", () => {
  const actions = { switchSession: vi.fn(), openThread: vi.fn(), openConversationView: vi.fn() } as unknown as WorkbenchActions;
  const tool = { id: "native-agent:codex:child", kind: "subagent", name: "tau_native_subagent", args: { agentId: "child", runtime: "codex", title: "Native reviewer", model: "gpt-5.6-luna", agentStatus: "completed" }, status: "done", output: "Native answer", startedAt: 1000, endedAt: 2000 } as UiToolRun;
  render(<TestProviders><TestThreadStore threads={sessions}><WorkbenchContext.Provider value={{ tools: [tool] } as never}><AgentLineage snapshot={{ sessionId: "parent" } as HostSnapshot} actions={actions} /></WorkbenchContext.Provider></TestThreadStore></TestProviders>);
  // The indexed child "Review layout" is idle, so it folds beside the native one.
  fireEvent.click(screen.getByRole("button", { name: "Previous agents (2)" }));
  fireEvent.click(screen.getByRole("button", { name: "Native reviewer, Completed" }));
  expect(actions.openConversationView).toHaveBeenCalledWith(SUBAGENT_VIEW, { toolId: "native-agent:codex:child" });
  expect(actions.switchSession).not.toHaveBeenCalled();
  expect(actions.openThread).not.toHaveBeenCalled();
});
it("opens a child thread in place of the parent's transcript where the core offers conversation views", () => {
  agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "running" }] });
  const actions = { switchSession: vi.fn(), openThread: vi.fn(), openConversationView: vi.fn() } as unknown as WorkbenchActions;
  render(<TestProviders><TestThreadStore threads={sessions}><WorkbenchContext.Provider value={{ tools: [] } as never}><AgentLineage snapshot={{ sessionId: "parent" } as HostSnapshot} actions={actions} /></WorkbenchContext.Provider></TestThreadStore></TestProviders>);
  fireEvent.click(screen.getByRole("button", { name: "Review layout, Running" }));
  expect(actions.openConversationView).toHaveBeenCalledWith(SUBAGENT_VIEW, { threadId: "child" });
  expect(actions.openThread).not.toHaveBeenCalled();
  expect(actions.switchSession).not.toHaveBeenCalled();
});

it("stops a running agent from its row, and the stop takes the timer's place", async () => {
  agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "running", effort: "high", model: "openai/gpt-5.6" }] });
  const invoke = vi.fn(async () => ({}));
  agentsHost.invoke = invoke;
  setup();
  const row = screen.getByRole("button", { name: "Review layout, Running" });
  // The hover card names the model and the effort.
  expect(row.getAttribute("data-tooltip")).toBe("Review layout\ngpt-5.6 · High\nRunning");
  // Beside the row, not in it: a button cannot hold a button.
  expect(row.querySelector("button")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop Review layout" }));
  expect(invoke).toHaveBeenCalledWith("stop-agent", { threadId: "child" });
  delete agentsHost.invoke;
});
it("offers no stop for a finished agent", () => {
  agentsStore.set({ maxRunning: 8, links: [link] });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Previous agents (1)" }));
  expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull();
});
it("stops a native child through its task", () => {
  const stopBackground = vi.fn(async () => undefined);
  const actions = { switchSession: vi.fn(), openThread: vi.fn(), openConversationView: vi.fn(), stopBackground, notify: vi.fn() } as unknown as WorkbenchActions;
  const tool = { id: "native-agent:claude-code:call", kind: "subagent", name: "tau_native_subagent", args: { agentId: "call", runtime: "claude-code", title: "Native reviewer", agentStatus: "running", taskId: "task-7", effort: "low", model: "haiku" }, status: "running", output: "", startedAt: 1000 } as UiToolRun;
  render(<TestProviders><TestThreadStore threads={sessions}><WorkbenchContext.Provider value={{ tools: [tool] } as never}><AgentLineage snapshot={{ sessionId: "parent" } as HostSnapshot} actions={actions} /></WorkbenchContext.Provider></TestThreadStore></TestProviders>);
  expect(screen.getByRole("button", { name: "Native reviewer, Running" }).getAttribute("data-tooltip")).toBe("Native reviewer\nhaiku · Low\nRunning");
  fireEvent.click(screen.getByRole("button", { name: "Stop Native reviewer" }));
  expect(stopBackground).toHaveBeenCalledWith("task-7");
});
it("shows who asks above the composer, however deep, and opens the agent", () => {
  const actions = { switchSession: vi.fn(), openThread: vi.fn(), openConversationView: vi.fn(), activeThread: () => ({ sessionId: "parent" }) } as unknown as WorkbenchActions;
  agentsStore.set({ maxRunning: 8, links: [
    { ...link, status: "running" },
    { ...link, id: "grand", threadId: "grand", parentThreadId: "child", title: "Deep check", status: "waiting", depth: 2, spawnedAt: 2000 },
  ] });
  render(<AgentQuestionsBanner snapshot={{ sessionId: "parent" } as HostSnapshot} actions={actions} />);
  expect(screen.getByText("Sub-agent needs input")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open question" }));
  expect(actions.openConversationView).toHaveBeenCalledWith(SUBAGENT_VIEW, { threadId: "grand" });
  act(() => agentsStore.set({ maxRunning: 8, links: [{ ...link, status: "running" }] }));
  expect(screen.queryByText("Sub-agent needs input")).toBeNull();
});

const nativeTool = (index: number, agentStatus: string, endedAt?: number) => ({
  id: `native-agent:claude-code:${index}`, kind: "subagent", name: "tau_native_subagent",
  args: { agentId: String(index), runtime: "claude-code", title: `Native ${index}`, agentStatus },
  status: agentStatus === "running" ? "running" : agentStatus === "failed" ? "error" : "done", output: "", startedAt: index * 1000,
  ...(endedAt ? { endedAt } : {}),
}) as UiToolRun;

it("folds finished native children under Previous agents, the latest first, and pages them", () => {
  const actions = { switchSession: vi.fn(), openThread: vi.fn(), openConversationView: vi.fn() } as unknown as WorkbenchActions;
  const tools = [nativeTool(0, "running"), ...Array.from({ length: 20 }, (_, index) => nativeTool(index + 1, index === 3 ? "failed" : "completed", 100_000 + index))];
  render(<TestProviders><TestThreadStore threads={sessions}><WorkbenchContext.Provider value={{ tools } as never}><AgentLineage snapshot={{ sessionId: "parent" } as HostSnapshot} actions={actions} /></WorkbenchContext.Provider></TestThreadStore></TestProviders>);
  expect(screen.getByText("Agents · 1 running")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Native 0, Running" })).toBeTruthy();
  const toggle = screen.getByRole("button", { name: /^Previous agents \(21\)/ });
  expect(toggle.querySelector(".agent-lineage-failed")?.textContent).toBe("1 failed");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: /^Native 20,/ })).toBeNull();
  fireEvent.click(toggle);
  const shown = () => screen.getAllByRole("button", { name: /^Native \d+, (Completed|Failed)$/ }).map((row) => row.getAttribute("aria-label"));
  expect(shown()).toEqual(["Native 20, Completed", "Native 19, Completed", "Native 18, Completed", "Native 17, Completed", "Native 16, Completed", "Native 15, Completed"]);
  fireEvent.click(screen.getByRole("button", { name: "Show 12 more" }));
  expect(shown()).toHaveLength(18);
  fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
  expect(shown()).toHaveLength(20);
  expect(screen.getByRole("button", { name: "Review layout, Idle" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
});
