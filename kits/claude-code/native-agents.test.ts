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

it("takes a long command's heartbeat for the command it is, not a subagent", () => {
  const agents = new ClaudeNativeAgents();
  // The CLI sends one every few seconds once a foreground command has run for 30 s.
  const frames = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "npm run build" } }] } },
    { type: "system", subtype: "task_started", task_id: "shell", tool_use_id: "bash", task_type: "local_bash", description: "Build" },
    { type: "tool_progress", tool_use_id: "beat-0", tool_name: "Bash", parent_tool_use_id: "bash", elapsed_time_seconds: 30 },
    { type: "system", subtype: "task_notification", task_id: "shell", tool_use_id: "bash", status: "completed" },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "built" }] } },
  ];
  expect(frames.flatMap((frame) => agents.push(frame))).toEqual([]);
  expect(agents.owns("bash")).toBe(false);
});

it("shows a subagent's tool progress as its last tool", () => {
  const agents = new ClaudeNativeAgents();
  agents.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Agent", input: { description: "Review" } }] } });
  const progress = agents.push({ type: "tool_progress", tool_use_id: "read", tool_name: "Read", parent_tool_use_id: "call", elapsed_time_seconds: 31 });
  expect(progress.at(-1)).toMatchObject({ tool: { args: { title: "Review", lastTool: "Read" } } });
});

it("keeps one row for an agent SendMessage resumes", () => {
  const agents = new ClaudeNativeAgents();
  agents.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "launch", name: "Agent", input: { description: "Agent A", run_in_background: true } }] } });
  agents.push({ type: "system", subtype: "task_started", task_id: "a", tool_use_id: "launch", task_type: "local_agent", description: "Agent A" });
  agents.push({ type: "system", subtype: "task_notification", task_id: "a", tool_use_id: "launch", status: "completed" });

  agents.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "resume", name: "SendMessage", input: { to: "a", message: "Again" } }] } });
  const resumed = agents.push({ type: "system", subtype: "task_started", task_id: "a", tool_use_id: "resume", task_type: "local_agent", description: "Agent A" });
  expect(resumed.at(-1)).toMatchObject({ tool: { id: "native-agent:claude-code:launch", status: "running" } });
  const reply = agents.push({ type: "assistant", parent_tool_use_id: "resume", message: { id: "second", content: [{ type: "text", text: "A_SECOND" }] } });
  expect(reply.at(-1)).toMatchObject({ tool: { id: "native-agent:claude-code:launch" } });
  // SendMessage's own answer belongs to the main loop.
  expect(agents.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "resume", content: "Resuming agent a" }] } })).toEqual([]);
  const done = agents.push({ type: "system", subtype: "task_notification", task_id: "a", tool_use_id: "resume", status: "completed" });
  expect(done.at(-1)).toMatchObject({ tool: { id: "native-agent:claude-code:launch", status: "done" } });
  expect(agents.owns("resume")).toBe(false);
});

it("names a subagent whose launch it missed by the task its frames carry", () => {
  const agents = new ClaudeNativeAgents();
  const child = agents.push({ type: "assistant", parent_tool_use_id: "earlier", subagent_type: "Explore", task_description: "Find the parser", message: { id: "reply", content: [{ type: "text", text: "Found it" }] } });
  expect(child.at(-1)).toMatchObject({ tool: { args: { title: "Find the parser" }, output: "Found it" } });
});
