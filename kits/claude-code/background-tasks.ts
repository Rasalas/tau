import type { UiBackgroundTask } from "tau/host-extension";

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

/** Claude runs a Monitor as `local_bash`; only the tool call tells the two apart. */
function kindOf(taskType: string | undefined): UiBackgroundTask["kind"] {
  if (taskType === "local_bash") return "command";
  if (taskType === "local_agent" || taskType === "remote_agent" || taskType === "in_process_teammate") return "agent";
  return "task";
}

/**
 * The CLI's live background tasks: its `background_tasks_changed` level where
 * the CLI sends one, else the `task_started`/`task_notification` bookends.
 * Ambient housekeeping is left out, as the SDK asks.
 */
export class ClaudeBackgroundTasks {
  private readonly tasks = new Map<string, UiBackgroundTask>();
  /** What `task_started` said about a task: the level carries no tool-use id. */
  private readonly started = new Map<string, { kind: UiBackgroundTask["kind"]; label: string }>();
  private readonly monitorCalls = new Set<string>();
  private levels = false;

  constructor(private readonly now: () => number) {}

  get size(): number { return this.tasks.size; }
  current(): UiBackgroundTask[] { return [...this.tasks.values()].map((task) => ({ ...task })); }
  has(taskId: string): boolean { return this.tasks.has(taskId); }

  /** Answers whether the list changed. */
  push(raw: unknown): boolean {
    const frame = object(raw);
    if (frame.type === "assistant") {
      for (const block of Array.isArray(object(frame.message).content) ? (object(frame.message).content as unknown[]).map(object) : []) {
        if (block.type === "tool_use" && block.name === "Monitor" && string(block.id)) this.monitorCalls.add(String(block.id));
      }
      return false;
    }
    if (frame.type !== "system") return false;
    if (frame.subtype === "background_tasks_changed" && Array.isArray(frame.tasks)) {
      this.levels = true;
      const before = JSON.stringify(this.current());
      const next = new Map<string, UiBackgroundTask>();
      for (const task of frame.tasks.map(object)) {
        const id = string(task.task_id);
        if (!id || task.ambient === true) continue;
        next.set(id, this.task(id, kindOf(string(task.task_type)), string(task.description)));
      }
      this.tasks.clear();
      for (const [id, task] of next) this.tasks.set(id, task);
      return JSON.stringify(this.current()) !== before;
    }
    const id = string(frame.task_id);
    if (!id) return false;
    if (frame.subtype === "task_started") {
      if (frame.ambient === true || frame.skip_transcript === true) return false;
      const toolUseId = string(frame.tool_use_id);
      const kind = toolUseId && this.monitorCalls.has(toolUseId) ? "monitor" : kindOf(string(frame.task_type));
      const label = string(frame.description) ?? string(frame.subagent_type) ?? "Background task";
      this.started.set(id, { kind, label });
      // The level usually came first and named the task without knowing it is a monitor.
      if (this.tasks.has(id)) return this.replace(id, { ...this.tasks.get(id)!, kind, label });
      if (this.levels || frame.is_backgrounded === false) return false;
      this.tasks.set(id, this.task(id, kind, label));
      return true;
    }
    if (frame.subtype === "task_updated" && object(frame.patch).is_backgrounded === true && !this.levels && !this.tasks.has(id)) {
      const known = this.started.get(id);
      if (!known) return false;
      this.tasks.set(id, this.task(id, known.kind, known.label));
      return true;
    }
    if (frame.subtype === "task_notification") {
      this.started.delete(id);
      return this.tasks.delete(id);
    }
    return false;
  }

  /** A new CLI process starts with no tasks; the level begins again. */
  clear(): boolean {
    const had = this.tasks.size > 0;
    this.tasks.clear();
    this.started.clear();
    this.monitorCalls.clear();
    this.levels = false;
    return had;
  }

  private task(id: string, kind: UiBackgroundTask["kind"], label: string | undefined): UiBackgroundTask {
    const known = this.tasks.get(id);
    const started = this.started.get(id);
    return {
      id,
      kind: started?.kind ?? kind,
      label: started?.label ?? label ?? known?.label ?? "Background task",
      startedAt: known?.startedAt ?? this.now(),
    };
  }

  private replace(id: string, task: UiBackgroundTask): boolean {
    const known = this.tasks.get(id);
    if (known?.kind === task.kind && known.label === task.label) return false;
    this.tasks.set(id, task);
    return true;
  }
}
