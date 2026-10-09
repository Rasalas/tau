import type { ThreadRuntimeEvent, UiToolRun } from "tau/host-extension";

export const NATIVE_AGENT_TOOL = "tau_native_subagent";
export type NativeAgentStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "cancelled";

/** One step of a native child's run as its view lists it: a reply, a tool it called, or an error. */
export interface NativeAgentEntry {
  id: string;
  kind: "text" | "tool" | "error";
  text: string;
  /** A tool's subject: the command, the file, the pattern. */
  detail?: string;
}

/** What a child's run keeps in `args.entries`; the oldest drop first past this. */
const ENTRIES_MAX_CHARS = 24_000;

/** A tool call's subject in one line, from the input fields runtimes commonly use. */
export function toolDetail(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.trim().split("\n")[0]!;
      return line.length > 160 ? `${line.slice(0, 159)}…` : line;
    }
  }
  return undefined;
}

/** Native children belong to their parent's activity, never to Tau's thread index. */
export class NativeAgentTracker {
  private readonly agents = new Map<string, UiToolRun>();
  private readonly entries = new Map<string, Map<string, NativeAgentEntry>>();
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
    const previous = this.entries.get(id)?.get(messageId)?.text;
    return this.record(id, { id: messageId, kind: messageId === "error" ? "error" : "text", text: (append ? (previous ?? "") + text : text).slice(-8_000) });
  }

  /** A tool the child called; `name` also becomes its last tool. */
  tool(id: string, toolId: string, name: string, detail?: string): ThreadRuntimeEvent[] {
    if (!this.has(id)) return [];
    this.update(id, { lastTool: name });
    return this.record(id, { id: `tool:${toolId}`, kind: "tool", text: name, ...(detail ? { detail } : {}) });
  }

  interrupt(): ThreadRuntimeEvent[] {
    return [...this.agents].flatMap(([id, agent]) => agent.status === "running" ? this.update(id, { status: "cancelled" }) : []);
  }

  private record(id: string, entry: NativeAgentEntry): ThreadRuntimeEvent[] {
    if (!this.has(id)) return [];
    const entries = this.entries.get(id) ?? new Map<string, NativeAgentEntry>();
    entries.set(entry.id, entry);
    let size = [...entries.values()].reduce((sum, item) => sum + item.text.length + (item.detail?.length ?? 0), 0);
    for (const [key, item] of entries) {
      if (size <= ENTRIES_MAX_CHARS || entries.size <= 1) break;
      size -= item.text.length + (item.detail?.length ?? 0);
      entries.delete(key);
    }
    this.entries.set(id, entries);
    const list = [...entries.values()];
    const tool = this.agents.get(id)!;
    this.agents.set(id, {
      ...tool,
      args: { ...tool.args, entries: list },
      output: list.map((item) => item.kind === "tool" ? item.detail ?? item.text : item.text).join("\n\n").slice(-12_000),
    });
    return this.update(id);
  }
}
