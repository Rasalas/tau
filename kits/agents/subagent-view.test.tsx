// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostSnapshot, UiToolRun, WorkbenchActions } from "tau";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { SubagentView, useOpenedSubagent } from "./subagent-view.js";

afterEach(cleanup);

const tool = (change: Partial<UiToolRun> = {}, args: Record<string, unknown> = {}): UiToolRun => ({
  id: "native-agent:claude-code:call", kind: "subagent", name: "tau_native_subagent", status: "running", startedAt: 1000,
  args: { agentId: "call", runtime: "claude-code", title: "Review the parser", model: "claude-haiku-4-5", agentStatus: "running", entries: [
    { id: "reply", kind: "text", text: "Looking at **the parser**." },
    { id: "tool:1", kind: "tool", text: "Bash", detail: "npm test" },
  ], ...args },
  ...change,
});

function view(run: UiToolRun, onClose = vi.fn(), history: UiToolRun[] = [], toolId = run.id) {
  const snapshot = { sessionId: "parent", sessionTitle: "Build the app", turnActivityHistory: [{ id: "turn", anchorMessageId: "m", status: "done", tools: history }] } as unknown as HostSnapshot;
  const ui = (live: UiToolRun[]) => <TestProviders><WorkbenchContext.Provider value={{ tools: live } as never}>
    <SubagentView snapshot={snapshot} params={{ toolId }} actions={{} as WorkbenchActions} onClose={onClose} />
  </WorkbenchContext.Provider></TestProviders>;
  const result = render(ui([run]));
  return { onClose, update: (next: UiToolRun) => result.rerender(ui([next])) };
}

it("reads a native child's steps and goes back to the parent from the divider, the bar and Escape", () => {
  const { onClose, update } = view(tool());
  const region = screen.getByRole("region", { name: "Subagent Review the parser" });
  expect(region.querySelector("strong")?.textContent).toBe("Subagent of");
  expect(region.textContent).toContain("Build the app");
  expect(region.querySelector(".subagent-entry-text strong")?.textContent).toBe("the parser");
  expect(region.querySelector(".subagent-entry-tool")?.textContent).toBe("Bashnpm test");
  expect(region.querySelector(".subagent-bar")?.textContent).toContain("claude-haiku-4-5");
  expect(region.querySelector(".subagent-bar")?.textContent).toContain("Runs on its own");

  update(tool({ status: "done", endedAt: 6000 }, { agentStatus: "completed", entries: [{ id: "result", kind: "text", text: "All green" }] }));
  expect(region.textContent).toContain("All green");
  expect(region.querySelector(".subagent-bar-status")?.textContent).toBe("Done 0:05");

  fireEvent.click(screen.getByRole("button", { name: /Subagent of/ }));
  fireEvent.click(screen.getByRole("button", { name: "Open parent" }));
  fireEvent.keyDown(region, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(3);
});

it("falls back to the joined text of a run recorded before steps were kept", () => {
  const settled = tool({ status: "done", endedAt: 2000, output: "Old answer" }, { agentStatus: "completed", entries: undefined });
  view(settled, vi.fn(), [], "gone");
  expect(screen.getByRole("status").textContent).toBe("This subagent is not part of the thread any more.");
  cleanup();
  view({ ...settled, id: "live" }, vi.fn(), [settled], settled.id);
  expect(screen.getByRole("region", { name: "Subagent Review the parser" }).textContent).toContain("Old answer");
});

it("tells the lineage which child is on screen while the view is open", () => {
  let opened: string | undefined;
  function Probe() { opened = useOpenedSubagent(); return null; }
  render(<Probe />);
  const { unmount } = render(<TestProviders><WorkbenchContext.Provider value={{ tools: [tool()] } as never}>
    <SubagentView snapshot={{ sessionId: "parent" } as HostSnapshot} params={{ toolId: tool().id }} actions={{} as WorkbenchActions} onClose={vi.fn()} />
  </WorkbenchContext.Provider></TestProviders>);
  expect(opened).toBe(tool().id);
  act(() => unmount());
  expect(opened).toBeUndefined();
});
