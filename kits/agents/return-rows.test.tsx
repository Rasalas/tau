// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { UiToolRun, WorkbenchActions } from "tau";
import { agentReturnRows } from "./return-rows.js";

const tool: UiToolRun = { id: "child", name: "tau_native_subagent", kind: "subagent", status: "running", startedAt: 1,
  args: { title: "Review", runtime: "codex", reports: [
    { id: "1", timestamp: 3, status: "completed" },
    { id: "2", timestamp: 6, status: "failed" },
  ] } };
const messages = [
  { id: "u", role: "user" as const, text: "Inspect", timestamp: 1 },
  { id: "a", role: "assistant" as const, text: "First return", timestamp: 4 },
  { id: "u2", role: "user" as const, text: "Again", timestamp: 5 },
];

it("keeps earlier return outcomes when the same child is working again", () => {
  const actions = { openConversationView: vi.fn() } as unknown as WorkbenchActions;
  const rows = agentReturnRows({ tools: [tool], messages, actions });
  expect(rows.map(({ id, afterMessageId }) => ({ id, afterMessageId }))).toEqual([
    { id: "agents.return:child:1", afterMessageId: "u" },
    { id: "agents.return:child:2", afterMessageId: "u2" },
  ]);
  render(<>{rows.map((row) => <div key={row.id}>{row.content}</div>)}</>);
  fireEvent.click(screen.getByRole("button", { name: 'Subagent "Review" finished. Open subagent' }));
  expect(actions.openConversationView).toHaveBeenCalledWith("agents.subagent", { toolId: "child" });
  expect(screen.getByRole("note", { name: 'Subagent "Review" failed' })).toBeTruthy();
});

it("leaves returns outside the loaded transcript window hidden and ignores malformed records", () => {
  const actions = {} as WorkbenchActions;
  const native = { ...tool, args: { ...tool.args, reports: [null, { id: "bad", timestamp: Infinity, status: "completed" }, ...tool.args.reports as unknown[]] } };
  expect(agentReturnRows({ tools: [native], messages: messages.slice(1), actions }).map((row) => row.id)).toEqual(["agents.return:child:2"]);
  expect(agentReturnRows({ tools: [native], messages: [], actions })).toEqual([]);
});
