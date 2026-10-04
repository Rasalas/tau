import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { projectCompletedTurnWork } from "./completed-turn-work";
import { completedWorkMetadata, type TranscriptActivity } from "./transcript-activity";

const messages: UiMessage[] = [
  { id: "prompt", role: "user", text: "Check this", timestamp: 0 },
  { id: "progress", sourceEntryId: "progress-entry", role: "assistant", text: "Reading the file", thinking: "Look at the parser", timestamp: 1000 },
  { id: "final", role: "assistant", text: "The parser is correct", timestamp: 5000 },
];
const tool: TranscriptActivity = { id: "tools", afterMessageId: "progress-entry", foldWithTurn: true, content: "Read parser" };

describe("completed turn projection", () => {
  it("keeps the final answer and folds commentary, reasoning and tools under one stable prompt", () => {
    const projection = projectCompletedTurnWork(messages, [tool], false);
    expect(projection.messages.map((message) => message.id)).toEqual(["prompt", "final"]);
    expect(projection.work.get("prompt")).toMatchObject({ label: "Worked for 5s", messages: [messages[1]], activities: [tool] });
    expect(projection.activities).toEqual([]);
    expect(projection.aliases.get("progress-entry")).toBe("prompt");
  });

  it("keeps a running turn, incomplete answer and failed answer fully visible", () => {
    expect(projectCompletedTurnWork(messages, [tool], true).work.size).toBe(0);
    expect(projectCompletedTurnWork(messages.slice(0, 2), [tool], true).work.size).toBe(0);
    expect(projectCompletedTurnWork([...messages, { id: "error", role: "assistant", text: "", timestamp: 6000, error: "Provider failed" }], [tool], false).work.size).toBe(0);
    expect(projectCompletedTurnWork(messages, [{ ...tool, preventTurnFold: true }], false).work.size).toBe(0);
  });

  it("keeps extension rows visible and reanchors them without losing the final or trailing tools", () => {
    const extension = { id: "question", afterMessageId: "progress-entry", content: "Answer this" };
    const trailing = { ...tool, id: "trailing", afterMessageId: "final" };
    const projection = projectCompletedTurnWork(messages, [tool, extension, trailing], false);
    expect(projection.activities).toEqual([{ ...extension, afterMessageId: "prompt" }, trailing]);
  });

  it("retains explicit expansion and reports failed tool calls without claiming recovery", () => {
    const projection = projectCompletedTurnWork(messages, [{ ...tool, keepTurnOpen: true, failedTools: 1 }], false);
    expect(projection.work.get("prompt")).toMatchObject({ label: "Worked for 5s · 1 failed call", keepOpen: true });
  });

  it("folds reasoning attached to the final answer with the rest of the work", () => {
    const projection = projectCompletedTurnWork([messages[0]!, { ...messages[2]!, thinking: "Check escaping" }], [], false);
    expect(projection.messages[1]).toMatchObject({ id: "final", text: "The parser is correct", thinking: undefined });
    expect(projection.work.get("prompt")?.messages[0]).toMatchObject({ id: "final:thinking", text: "", thinking: "Check escaping" });
  });

  it("leaves persistent cards, approvals, questions and interrupted tools out of folding", () => {
    const run = { id: "t", name: "read", args: {}, status: "done" as const, startedAt: 0 };
    expect(completedWorkMetadata([run], "completed", () => true, false).foldWithTurn).toBe(false);
    expect(completedWorkMetadata([{ ...run, name: "ask_user_question" }], "completed", () => false, false).foldWithTurn).toBe(false);
    expect(completedWorkMetadata([{ ...run, status: "running" }], "completed", () => false, false).preventTurnFold).toBe(true);
    expect(completedWorkMetadata([run], "running", () => false, false).preventTurnFold).toBe(true);
    expect(completedWorkMetadata([run], "interrupted", () => false, false).preventTurnFold).toBe(true);
    expect(completedWorkMetadata([{ ...run, status: "error" }], "error", () => false, false)).toMatchObject({
      foldWithTurn: true, preventTurnFold: false, failedTools: 1,
    });
  });
});
