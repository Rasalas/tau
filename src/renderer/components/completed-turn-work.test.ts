import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { wakeMessageText } from "../../shared/message-turns";
import { CompletedTurnWorkCache, projectCompletedTurnWork } from "./completed-turn-work";
import { completedWorkMetadata, type TranscriptActivity } from "./transcript-activity";

const messages: UiMessage[] = [
  { id: "prompt", role: "user", text: "Check this", timestamp: 0 },
  { id: "progress", sourceEntryId: "progress-entry", role: "assistant", text: "Reading the file", thinking: "Look at the parser", timestamp: 1000 },
  { id: "final", role: "assistant", text: "The parser is correct", timestamp: 5000 },
];
const tool: TranscriptActivity = { id: "tools", afterMessageId: "progress-entry", foldWithTurn: true, content: "Read parser" };

describe("completed turn projection", () => {
  it("keeps answers between wakes visible when the thread settles", () => {
    const history: UiMessage[] = [
      messages[0]!,
      { id: "answer-before-wake", role: "assistant", text: "The first PR is merged", timestamp: 1000 },
      { id: "wake", role: "user", text: wakeMessageText({ source: "pull-request", label: "PR #42 · checks passed" }, "Checks passed."), timestamp: 2000 },
      { id: "answer-after-wake", role: "assistant", text: "The second PR is merged", timestamp: 3000 },
    ];
    for (const streaming of [true, false]) {
      expect(projectCompletedTurnWork(history, [], streaming).messages.map((message) => message.id)).toEqual(history.map((message) => message.id));
    }
  });

  it("folds a wake's work in a history window with no user prompt, leaving consecutive wake lines visible", () => {
    const history: UiMessage[] = [
      { id: "wake-one", role: "user", text: wakeMessageText({ source: "pull-request", label: "PR #41 · checks passed" }, ""), timestamp: 0 },
      { id: "wake-two", role: "user", text: wakeMessageText({ source: "pull-request", label: "PR #42 · checks passed" }, ""), timestamp: 1000 },
      messages[1]!,
      messages[2]!,
    ];
    const projection = projectCompletedTurnWork(history, [tool], false);
    expect(projection.messages.map((message) => message.id)).toEqual(["wake-one", "wake-two", "final"]);
    expect([...projection.work.keys()]).toEqual(["wake-two"]);
    expect(projection.work.get("wake-two")).toMatchObject({ messages: [messages[1]], activities: [tool] });
    expect(projection.aliases.get("progress-entry")).toBe("wake-two");
    expect(projection.activities).toEqual([]);
  });

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

  it("keeps every settled turn's objects while the last turn streams", () => {
    const settled: UiMessage[] = Array.from({ length: 20 }, (_, turn) => [
      { id: `prompt-${turn}`, role: "user" as const, text: "Ask", timestamp: turn * 10 },
      { id: `progress-${turn}`, role: "assistant" as const, text: "Reading", timestamp: turn * 10 + 1 },
      { id: `final-${turn}`, role: "assistant" as const, text: "Done", thinking: "Because", timestamp: turn * 10 + 2 },
    ]).flat();
    const activities: TranscriptActivity[] = settled.filter((message) => message.id.startsWith("progress-"))
      .map((message) => ({ id: `tools-${message.id}`, afterMessageId: message.id, foldWithTurn: true, content: "Read" }));
    const cache = new CompletedTurnWorkCache();
    const live: UiMessage = { id: "prompt-live", role: "user", text: "Next", timestamp: 1_000 };
    const frame = (text: string) => projectCompletedTurnWork([
      ...settled,
      live,
      { id: "live", role: "assistant", text, timestamp: 1_001 },
    ], [...activities], true, cache);
    const first = frame("Stre");
    const next = frame("Streaming");
    expect(next.messages.slice(0, -1).every((message, index) => message === first.messages[index])).toBe(true);
    expect([...next.work].every(([id, work]) => work === first.work.get(id))).toBe(true);
    expect(next.aliases).toBe(first.aliases);
    expect(next.messages.at(-1)?.text).toBe("Streaming");
    expect(first.messages.find((message) => message.id === "final-0")).toMatchObject({ thinking: undefined });
    // Without a cache every frame makes new ones, which is what made each settled answer render again.
    expect(projectCompletedTurnWork(settled, activities, false).work.get("prompt-0"))
      .not.toBe(projectCompletedTurnWork(settled, activities, false).work.get("prompt-0"));
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
