import type { ThreadBackgroundCapability, UiBackgroundTask, UiToolRun } from "tau/host-extension";

/** Tasks with observed lifetimes. A result is cleared only by a successful turn which began with that result. */
export class BackgroundTasks {
  private readonly tasks = new Map<string, UiBackgroundTask>();
  private readonly versions = new Map<string, number>();
  private sequence = 0;
  current(): UiBackgroundTask[] { return [...this.tasks.values()].map((task) => ({ ...task })); }
  has(id: string): boolean { return this.tasks.has(id); }
  start(task: UiBackgroundTask): void { this.tasks.set(task.id, { ...task }); this.versions.set(task.id, ++this.sequence); }
  fromTools(tools: readonly UiToolRun[], commands?: ReadonlySet<string>): void {
    for (const tool of tools) this.start({ id: tool.id, kind: commands?.has(tool.id) || tool.name === "bash" || tool.name === "powershell" ? "command" : tool.kind === "subagent" ? "agent" : "task", label: typeof tool.args.command === "string" ? tool.args.command : tool.name, startedAt: tool.startedAt });
  }
  report(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.state === "reported") return false;
    if (task.blocksCompletion === false) { this.forget(id); return true; }
    this.tasks.set(id, { ...task, state: "reported" });
    this.versions.set(id, ++this.sequence);
    return true;
  }
  release(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.state) throw new Error("That background command is no longer running.");
    if (task.kind !== "command") throw new Error("Only a checked command may be released as a service.");
    this.tasks.set(id, { ...task, blocksCompletion: false });
  }
  snapshot(): Map<string, number> {
    return new Map([...this.tasks].filter(([, task]) => task.state === "reported").map(([id]) => [id, this.versions.get(id)!]));
  }
  handled(snapshot: ReadonlyMap<string, number>): boolean {
    let changed = false;
    for (const [id, version] of snapshot) if (this.versions.get(id) === version && this.tasks.get(id)?.state === "reported") { this.forget(id); changed = true; }
    return changed;
  }
  forget(id: string): void { this.tasks.delete(id); this.versions.delete(id); }
  clear(): void { this.tasks.clear(); this.versions.clear(); }
  capability(changed: () => void): ThreadBackgroundCapability {
    return { current: () => this.current(), release: (id) => { this.release(id); changed(); }, stop: async (id) => {
      const tasks = id ? this.current().filter((task) => task.id === id) : this.current();
      if (tasks.some((task) => !task.state)) throw new Error("The runtime provides no task-specific stop handle. Use its own stop tool for this task.");
      for (const task of tasks) this.forget(task.id);
      changed();
    } };
  }
}
