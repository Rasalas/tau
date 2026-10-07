import { expect, it } from "vitest";
import { ClaudeNativeAgents } from "./native-agents.js";

it("joins Claude's native launch, child transcript, progress and background completion", () => {
  const agents = new ClaudeNativeAgents();
  const launch = agents.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Agent", input: { description: "Review", run_in_background: true } }] } });
  expect(launch[0]).toMatchObject({ type: "tool-end", tool: { kind: "subagent", args: { title: "Review" }, status: "running" } });
  agents.push({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "call", task_type: "local_agent", description: "Review" });
  const child = agents.push({ type: "assistant", parent_tool_use_id: "call", message: { id: "reply", model: "claude-haiku", content: [{ type: "text", text: "OK" }] } });
  expect(child.at(-1)).toMatchObject({ tool: { output: "OK", args: { model: "claude-haiku" } } });
  const placeholder = agents.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "Background task started" }] } });
  expect(placeholder.at(-1)).toMatchObject({ tool: { status: "running" } });
  const done = agents.push({ type: "system", subtype: "task_notification", task_id: "task", status: "completed", summary: "Reviewed" });
  expect(done.at(-1)).toMatchObject({ tool: { status: "done", args: { agentStatus: "completed" } } });
  expect(agents.tracker.busy).toBe(false);
});
it("does not present background shells as subagents and settles foreground Agent calls", () => {
  const agents = new ClaudeNativeAgents();
  expect(agents.push({ type: "system", subtype: "task_started", task_id: "shell", task_type: "local_bash", description: "Run build" })).toEqual([]);
  agents.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Task", input: {} }] } });
  expect(agents.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "failed", is_error: true }] } }).at(-1)).toMatchObject({ tool: { status: "error", args: { agentStatus: "failed" } } });
});

it("replaces child streaming deltas with the final message rather than repeating its text", () => {
  const agents = new ClaudeNativeAgents();
  agents.push({ type: "stream_event", parent_tool_use_id: "call", event: { type: "message_start", message: { id: "reply" } } });
  agents.push({ type: "stream_event", parent_tool_use_id: "call", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } });
  const final = agents.push({ type: "assistant", parent_tool_use_id: "call", message: { id: "reply", content: [{ type: "text", text: "Hello" }] } });
  expect(final.at(-1)).toMatchObject({ tool: { output: "Hello" } });
});
