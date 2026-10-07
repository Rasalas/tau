import { expect, it } from "vitest";
import type { UiToolRun } from "tau/host-extension";
import { CodexNativeAgents } from "./native-agents.js";

const tools = (result: ReturnType<CodexNativeAgents["push"]>) => result.events.flatMap((event) => event.type === "tool-end" ? [event.tool] : []);
it("keeps a native child transcript and resumable lifecycle inside the parent activity", () => {
  const agents = new CodexNativeAgents();
  const start = agents.push("thread/started", { thread: { id: "child", source: { subAgent: { thread_spawn: { parent_thread_id: "root", agent_nickname: "Reviewer" } } } } }, "root");
  expect(start.handled).toBe(true);
  expect(tools(start)[0]).toMatchObject({ kind: "subagent", args: { title: "Reviewer", agentId: "child" }, status: "running" });
  const delta = agents.push("item/agentMessage/delta", { threadId: "child", itemId: "reply", delta: "Looks good" }, "root");
  expect(tools(delta).at(-1)?.output).toBe("Looks good");
  const ended = agents.push("turn/completed", { threadId: "child", turn: { status: "completed" } }, "root");
  expect(tools(ended)[0]).toMatchObject({ args: { agentStatus: "idle" }, status: "done", output: "Looks good" });
  expect(agents.tracker.busy).toBe(false);
  const resumed = agents.push("turn/started", { threadId: "child", turnId: "next" }, "root");
  expect(tools(resumed)[0]?.id).toBe(tools(start)[0]?.id);
  expect(agents.tracker.busy).toBe(true);
});
it("handles both collaboration protocols and never captures the root or unrelated threads", () => {
  const agents = new CodexNativeAgents();
  expect(agents.push("turn/completed", { threadId: "stranger" }, "root").handled).toBe(false);
  expect(agents.push("turn/completed", { threadId: "root" }, "root").handled).toBe(false);
  expect(tools(agents.push("item/started", { threadId: "root", item: { type: "subAgentActivity", agentThreadId: "root", agentPath: "/root" } }, "root"))).toEqual([]);
  const legacy = agents.push("item/completed", { threadId: "root", item: { type: "collabAgentToolCall", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "OK" } } } }, "root");
  expect(tools(legacy).at(-1)).toMatchObject({ status: "done", output: "OK" } satisfies Partial<UiToolRun>);
});

it("keeps a child's failure visible when the process subsequently reports it as idle", () => {
  const agents = new CodexNativeAgents();
  agents.push("item/started", { threadId: "root", item: { type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/reviewer" } }, "root");
  agents.push("error", { threadId: "child", error: { message: "Child failed" }, willRetry: false }, "root");
  const idle = tools(agents.push("thread/status/changed", { threadId: "child", status: { type: "idle" } }, "root")).at(-1);
  expect(idle).toMatchObject({ status: "error", args: { agentStatus: "failed" }, output: "Child failed" });
  expect(tools(agents.push("turn/started", { threadId: "child" }, "root")).at(-1)).toMatchObject({ status: "running", args: { agentStatus: "running" } });
});
