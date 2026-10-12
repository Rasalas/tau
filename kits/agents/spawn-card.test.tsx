// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UiToolRun, WorkbenchActions } from "tau";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { SpawnCard } from "./spawn-card.js";
import { agentsStore } from "./store.js";
import { SUBAGENT_VIEW } from "./subagent-view.js";

afterEach(() => { agentsStore.clear(); vi.useRealTimers(); });

function native(id: string, runtime: string, status = "running", startedAt = 1000, endedAt?: number): UiToolRun {
  return { id, kind: "subagent", name: "tau_native_subagent", args: { title: `Review ${id}`, runtime, agentStatus: status },
    status: status === "running" ? "running" : "done", startedAt, ...(endedAt === undefined ? {} : { endedAt }) };
}

function draw(tools: UiToolRun[]) {
  const actions = { openConversationView: vi.fn() } as unknown as WorkbenchActions;
  const view = (next: UiToolRun[]) => <TestProviders><TestThreadStore threads={[]}><SpawnCard tools={next} actions={actions} /></TestThreadStore></TestProviders>;
  const result = render(view(tools));
  return { ...result, actions, update: (next: UiToolRun[]) => result.rerender(view(next)) };
}

it("keeps a batch's disclosure open while children finish and opens the selected child", () => {
  vi.useFakeTimers();
  vi.setSystemTime(61_000);
  const tools = [native("one", "codex"), native("two", "claude-code", "waiting", 5000)];
  const { container, update, actions } = draw(tools);
  const batch = screen.getByRole("button", { name: /Show agents/ });
  expect(batch.textContent).toBe("2 subagents1 working1 question1m 00s");
  expect(batch.getAttribute("aria-expanded")).toBe("false");
  expect(batch.querySelector(".provider-family-codex")).toBeTruthy();
  expect(batch.querySelector(".provider-family-claude-code")).toBeTruthy();
  fireEvent.click(batch);
  fireEvent.click(screen.getByRole("button", { name: "Review two, Needs your answer" }));
  expect(actions.openConversationView).toHaveBeenCalledWith(SUBAGENT_VIEW, { toolId: "two" });
  act(() => vi.advanceTimersByTime(2000));
  expect(batch.querySelector("time")?.textContent).toBe("1m 02s");
  update([native("one", "codex", "completed", 1000, 62_000), native("two", "claude-code", "failed", 5000, 63_000)]);
  expect(batch.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".agent-spawn-list .status-failed .agent-transcript-status")?.textContent).toBe("Failed");
  act(() => vi.advanceTimersByTime(5000));
  expect(batch.querySelector("time")?.textContent).toBe("1m 02s");
  fireEvent.click(batch);
  expect(screen.queryByRole("button", { name: "Review two, Failed" })).toBeNull();
});

it("opens a native singleton directly and retains its provider mark and status", () => {
  const { container, actions } = draw([native("single", "codex", "completed", 1000, 16_000)]);
  expect(screen.queryByRole("button", { name: /Show agents/ })).toBeNull();
  const row = screen.getByRole("button", { name: "Review single, Completed" });
  expect(row.textContent).toBe("Review singleCompleted15s");
  expect(container.querySelector(".provider-family-codex")).toBeTruthy();
  fireEvent.click(row);
  expect(actions.openConversationView).toHaveBeenCalledWith(SUBAGENT_VIEW, { toolId: "single" });
});

it("uses the child's full run duration instead of the brief spawn call", () => {
  agentsStore.set({ maxRunning: 8, links: [{ id: "child", threadId: "child", parentThreadId: "parent", title: "Review layout", status: "completed", spawnedBy: "tau_spawn_thread", spawnedAt: 1000, startedAt: 1000, endedAt: 57_000, projectPath: "/project", depth: 1 }] });
  draw([{ id: "spawn", name: "tau_spawn_thread", args: {}, output: '{"threadId":"child"}', status: "done", startedAt: 1000, endedAt: 2000 }]);
  expect(screen.getByRole("button", { name: "Review layout, Completed" }).querySelector("time")?.textContent).toBe("56s");
});
