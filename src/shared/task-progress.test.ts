import { describe, expect, it } from "vitest";
import type { UiTask, UiTaskProgressEntry } from "./contracts.js";
import { mergeTaskProgressHistory, taskProgressFromMessages, taskProgressHistoryFromMessages } from "./task-progress.js";

function result(action: string, tasks: unknown[], params: Record<string, unknown> = {}, nextId = 4) {
  return { role: "toolResult", toolName: "todo", details: { action, params, tasks, nextId } };
}

const oldCompleted = { id: 1, subject: "Old work", status: "completed" } satisfies UiTask;
const first = { id: 2, subject: "Inspect tasks", activeForm: "inspecting tasks", status: "completed" } satisfies UiTask;
const second = { id: 3, subject: "Render tasks", activeForm: "rendering tasks", status: "in_progress" } satisfies UiTask;

describe("taskProgressFromMessages", () => {
  it("shows active tasks and completed tasks touched in the current turn", () => {
    const messages = [
      result("update", [oldCompleted], { id: 1 }, 2),
      { role: "user", content: "add tasks" },
      result("create", [oldCompleted, { ...first, status: "pending" }], {}, 3),
      result("update", [oldCompleted, first], { id: 2 }, 3),
      result("create", [oldCompleted, first, second], {}, 4),
    ];

    expect(taskProgressFromMessages(messages)).toEqual({
      tasks: [first, second],
      completed: 1,
      total: 2,
    });
  });

  it("keeps steering updates for the same task in one anchored card", () => {
    const pending = { id: 2, subject: "Render tasks", status: "pending" };
    const completed = { ...pending, status: "completed" };
    const messages = [
      { role: "user", content: "start", tauEntryId: "user" },
      { role: "assistant", content: [{ type: "text", text: "I will do it." }], tauEntryId: "commentary" },
      result("create", [pending], {}, 3),
      { role: "user", content: "also align it", tauEntryId: "steer" },
      result("update", [completed], { id: 2 }, 3),
    ];
    expect(taskProgressHistoryFromMessages(messages)).toEqual([{
      id: "tasks-user",
      anchorMessageId: "commentary",
      progress: { tasks: [completed], completed: 1, total: 1 },
    }]);
  });

  it("prefers recent local anchors over a stale bridge snapshot", () => {
    const stale: UiTaskProgressEntry = { id: "tasks-user", anchorMessageId: "user", progress: { tasks: [first], completed: 1, total: 1 } };
    const recent = { ...stale, anchorMessageId: "assistant" };
    expect(mergeTaskProgressHistory([stale], [recent])).toEqual([recent]);
  });

  it("hides an entirely completed plan from the live dock but keeps its chat card", () => {
    const messages = [
      { role: "user", content: "old request", tauEntryId: "old-user" },
      result("update", [oldCompleted], { id: 1 }, 2),
      { role: "user", content: "new request", tauEntryId: "new-user" },
    ];
    expect(taskProgressFromMessages(messages)).toBeUndefined();
    expect(taskProgressHistoryFromMessages(messages)).toEqual([{
      id: "tasks-old-user",
      anchorMessageId: "old-user",
      progress: { tasks: [oldCompleted], completed: 1, total: 1 },
    }]);
  });
});
