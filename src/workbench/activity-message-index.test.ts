import { describe, expect, it } from "vitest";
import type { UiMessage, UiToolRun } from "../shared/contracts";
import { ActivityMessageIndex } from "./activity-message-index";
import { answerTimestampAfter } from "./transcript-folding";

const messages: UiMessage[] = [
  { id: "u1", role: "user", text: "Start", timestamp: 1 },
  { id: "a1", sourceEntryId: "entry-a1", role: "assistant", text: "First reply", timestamp: 3 },
  { id: "empty", role: "assistant", text: " \n", timestamp: 4 },
  { id: "a2", role: "assistant", text: "Answer", timestamp: 5 },
  { id: "steer", role: "user", text: "Continue", timestamp: 6 },
  { id: "a3", role: "assistant", text: "Next answer", timestamp: 9 },
];
const tool = (id: string, startedAt: number, status: UiToolRun["status"] = "done"): UiToolRun => ({
  id, name: "read", args: {}, status, startedAt,
});

describe("activity message index", () => {
  it("keeps the answer timestamp rule for user, assistant, missing and absent anchors", () => {
    const index = new ActivityMessageIndex(messages);
    for (const anchor of [...messages.map((message) => message.id), "missing", undefined]) {
      expect(index.answerAfter(anchor)).toBe(answerTimestampAfter(messages, anchor));
    }
    const beforePrompt: UiMessage[] = [{ id: "first", role: "assistant", text: "Unanchored", timestamp: 0 }, ...messages];
    expect(new ActivityMessageIndex(beforePrompt).answerAfter()).toBe(0);
  });

  it("splits calls across replies and steering without using empty assistant rows as anchors", () => {
    const tools = [tool("early", 2), tool("reply", 4), tool("after", 7)];
    expect(new ActivityMessageIndex(messages).splitTools(tools, "u1")).toEqual([
      { anchorMessageId: "u1", tools: [tools[0]] },
      { anchorMessageId: "a1", tools: [tools[1]] },
      { anchorMessageId: "steer", tools: [tools[2]] },
    ]);
  });

  it("resolves entry aliases and keeps persistent running cards at their call", () => {
    const tools = [tool("running", 4, "running"), tool("card", 4, "running")];
    expect(new ActivityMessageIndex(messages).splitTools(tools, "entry-a1", (run) => run.id === "card")).toEqual([
      { anchorMessageId: "steer", tools: [tools[0]] },
      { anchorMessageId: "entry-a1", tools: [tools[1]] },
    ]);
    expect(new ActivityMessageIndex(messages).splitTools(tools, "unloaded")).toEqual([{ anchorMessageId: "unloaded", tools }]);
  });
});
