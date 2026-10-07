import type { ThreadRuntimeEvent, UiToolRun } from "tau/host-extension";

export const NATIVE_AGENT_TOOL = "tau_native_subagent";
export type NativeAgentStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "cancelled";

/** Native children belong to their parent's activity, never to Tau's thread index. */
export class NativeAgentTracker {
  private readonly agents = new Map<string, UiToolRun>();
  private readonly messages = new Map<string, Map<string, string>>();
  constructor(private readonly runtime: string, private readonly now = Date.now) {}

  has(id: string): boolean { return this.agents.has(id); }
  get busy(): boolean { return [...this.agents.values()].some((agent) => agent.status === "running"); }

  update(id: string, change: { title?: string; model?: string; status?: NativeAgentStatus; lastTool?: string } = {}): ThreadRuntimeEvent[] {
    const previous = this.agents.get(id);
    const previousStatus = previous?.args.agentStatus;
    const terminal = previousStatus === "failed" || previousStatus === "cancelled" || previousStatus === "completed";
    const status = change.status === "idle" && terminal ? previousStatus : change.status ?? previousStatus ?? "running";
    const running = status === "running" || status === "waiting";
    const tool: UiToolRun = {
      id: `native-agent:${this.runtime}:${id}`, name: NATIVE_AGENT_TOOL, kind: "subagent",
      args: { agentId: id, runtime: this.runtime, title: id, ...previous?.args, ...change, agentStatus: status },
      status: running ? "running" : status === "failed" ? "error" : "done",
      startedAt: previous?.startedAt ?? this.now(),
      ...(previous?.output ? { output: previous.output } : {}),
      ...(!running ? { endedAt: previous?.status !== "running" ? previous?.endedAt ?? this.now() : this.now() } : {}),
    };
    this.agents.set(id, tool);
    // Upserts retain one card across child turns and background completions.
    return [{ type: "tool-end", tool }];
  }

  text(id: string, messageId: string, text: string, append = false): ThreadRuntimeEvent[] {
    if (!this.has(id)) return [];
    const messages = this.messages.get(id) ?? new Map<string, string>();
    messages.set(messageId, (append ? (messages.get(messageId) ?? "") + text : text).slice(-8_000));
    while (messages.size > 32) messages.delete(messages.keys().next().value!);
    this.messages.set(id, messages);
    const tool = this.agents.get(id)!;
    this.agents.set(id, { ...tool, output: [...messages.values()].join("\n\n").slice(-12_000) });
    return this.update(id);
  }

  interrupt(): ThreadRuntimeEvent[] {
    return [...this.agents].flatMap(([id, agent]) => agent.status === "running" ? this.update(id, { status: "cancelled" }) : []);
  }
}
