import { describe, expect, it } from "vitest";
import { ClaudeBackgroundTasks } from "./background-tasks.js";

const monitorCall = { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_m", name: "Monitor", input: { description: "Nightly run" } }] } };
const level = (...tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>) => ({ type: "system", subtype: "background_tasks_changed", tasks });
const started = (task_id: string, tool_use_id: string, extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "task_started", task_id, tool_use_id, description: "Nightly run", is_backgrounded: true, task_type: "local_bash", ...extra });
const notification = (task_id: string) => ({ type: "system", subtype: "task_notification", task_id, status: "completed", output_file: "", summary: "" });

describe("ClaudeBackgroundTasks", () => {
  it("types a Monitor from its tool call although the level, sent first, says local_bash", () => {
    const tasks = new ClaudeBackgroundTasks(() => 5);
    expect(tasks.push(monitorCall)).toBe(false);
    expect(tasks.push(level({ task_id: "b1", task_type: "local_bash", description: "Nightly run" }))).toBe(true);
    expect(tasks.current()).toEqual([{ id: "b1", kind: "command", label: "Nightly run", startedAt: 5 }]);
    expect(tasks.push(started("b1", "toolu_m"))).toBe(true);
    expect(tasks.current()).toEqual([{ id: "b1", kind: "monitor", label: "Nightly run", startedAt: 5 }]);
    expect(tasks.push(level())).toBe(true);
    expect(tasks.push(notification("b1"))).toBe(false);
    expect(tasks.current()).toEqual([]);
  });

  it("follows the bookends of a CLI that sends no level", () => {
    const tasks = new ClaudeBackgroundTasks(() => 7);
    expect(tasks.push(started("b2", "toolu_b", { description: "npm run dev" }))).toBe(true);
    expect(tasks.push(started("f1", "toolu_f", { is_backgrounded: false }))).toBe(false);
    expect(tasks.push(started("a1", "toolu_a", { task_type: "local_agent", description: "Review" }))).toBe(true);
    expect(tasks.current().map((task) => [task.id, task.kind])).toEqual([["b2", "command"], ["a1", "agent"]]);
    // A foreground command moved to the background.
    expect(tasks.push({ type: "system", subtype: "task_updated", task_id: "f1", patch: { is_backgrounded: true } })).toBe(true);
    expect(tasks.push(notification("b2"))).toBe(true);
    expect(tasks.current().map((task) => task.id)).toEqual(["a1", "f1"]);
  });

  it("leaves out ambient housekeeping", () => {
    const tasks = new ClaudeBackgroundTasks(() => 1);
    expect(tasks.push(started("h1", "toolu_h", { ambient: true }))).toBe(false);
    expect(tasks.push(level({ task_id: "h1", task_type: "local_bash", description: "watcher", ambient: true }))).toBe(false);
    expect(tasks.current()).toEqual([]);
  });

  it("forgets everything for a new CLI process", () => {
    const tasks = new ClaudeBackgroundTasks(() => 1);
    tasks.push(level({ task_id: "b1", task_type: "local_bash", description: "x" }));
    expect(tasks.clear()).toBe(true);
    expect(tasks.clear()).toBe(false);
    // Bookends count again until the new process sends a level.
    expect(tasks.push(started("b3", "toolu_c"))).toBe(true);
  });
});
