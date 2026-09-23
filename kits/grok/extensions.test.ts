import { describe, expect, it } from "vitest";
import { EMPTY_PLAN, askQuestionDialogs, exitPlanMarkdown, initializeCommands, isPlanFile, planReply, planWrite, turnCompletedUsage } from "./extensions.js";

const QUESTIONS = { method: "x.ai/ask_user_question", params: { sessionId: "s", toolCallId: "q", mode: "default", questions: [
  { question: "Which scope?", options: [{ label: "Workspace" }, { label: "Session", preview: "Only this session" }] },
  { question: "Which extras?", multiSelect: true, options: [{ label: "Tests" }, { label: "Docs" }] },
] } };

describe("Grok's own ACP methods", () => {
  it("pages its questions and answers with labels, a typed answer as a note beside Other", () => {
    const dialogs = askQuestionDialogs(QUESTIONS);
    expect(dialogs.prompts.map((prompt) => prompt.kind)).toEqual(["select", "input"]);
    expect(dialogs.prompts[0]!.extras?.["tau.questionnaire"]).toMatchObject({ index: 0, questions: [{ question: "Which scope?", multiSelect: false }, { question: "Which extras?", multiSelect: true }] });
    expect(dialogs.answer([{ value: "Session" }, { value: "1,2" }])).toEqual({
      outcome: "accepted",
      answers: { "Which scope?": ["Session"], "Which extras?": ["Tests", "Docs"] },
      annotations: { "Which scope?": { preview: "Only this session" } },
    });
    expect(dialogs.answer([{ value: "Only src/", typed: true }, { value: "docs please" }])).toEqual({
      outcome: "accepted",
      answers: { "Which scope?": ["Other"], "Which extras?": ["Other"] },
      annotations: { "Which scope?": { notes: "Only src/" }, "Which extras?": { notes: "docs please" } },
    });
    expect(dialogs.answer([{ cancelled: true }])).toEqual({ outcome: "cancelled" });
    // A question without options is a plain OK.
    expect(askQuestionDialogs({ questions: [{ question: "Continue?", options: [] }] }).prompts[0]).toMatchObject({ kind: "select", options: ["OK"] });
  });

  it("takes the plan exit_plan_mode carries, else the plan file written, else says there is none", () => {
    expect(exitPlanMarkdown({ planContent: "# Plan\n1. Do it" }, "older")).toBe("# Plan\n1. Do it");
    expect(exitPlanMarkdown({ method: "x.ai/exit_plan_mode", params: { planContent: "  " } }, "# From the file")).toBe("# From the file");
    expect(exitPlanMarkdown({}, undefined)).toBe(EMPTY_PLAN);
    expect(planReply(" # P ")).toBe("<proposed_plan>\n# P\n</proposed_plan>");
  });

  it("knows Grok's session plan file from a workspace's own plan.md", () => {
    expect(isPlanFile("/Users/me/.grok/sessions/repo/s1/plan.md", undefined)).toBe(true);
    expect(isPlanFile("/shadow/sessions/repo/s1/plan.md", "/shadow")).toBe(true);
    expect(isPlanFile("/repo/docs/plan.md", "/shadow")).toBe(false);
    expect(isPlanFile("/repo/.grok/sessions/../plan.md", undefined)).toBe(false);
    expect(planWrite({ sessionUpdate: "tool_call", toolCallId: "w", rawInput: { file_path: "/shadow/sessions/r/s/plan.md", content: "# Plan" } }, "/shadow")).toBe("# Plan");
    expect(planWrite({ sessionUpdate: "tool_call_update", toolCallId: "w", content: [{ type: "diff", path: "/h/.grok/sessions/r/s/plan.md", newText: "# Diffed" }] }, undefined)).toBe("# Diffed");
    expect(planWrite({ sessionUpdate: "tool_call", toolCallId: "w", rawInput: { file_path: "/repo/plan.md", content: "# Not it" } }, "/shadow")).toBeUndefined();
  });

  it("hides the commands that would go around Tau", () => {
    expect(initializeCommands({ _meta: { availableCommands: [{ name: "compact", description: "Summarize" }, { name: "always-approve" }, { name: "context" }, { name: "review", input: { hint: "path" } }] } }))
      .toEqual([{ name: "compact", description: "Summarize" }, { name: "review", hint: "path" }]);
  });

  it("counts a turn's usage without the cached part, and shares out the cost of models that name none", () => {
    expect(turnCompletedUsage({ sessionUpdate: "turn_completed", usage: { inputTokens: 1000, outputTokens: 20, cachedReadTokens: 400, cacheCreationTokens: 100, costUsdTicks: 25_000_000 } } as never))
      .toEqual([{ inputTokens: 500, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 100, totalTokens: 1020, costUsd: 0.0025 }]);
    const shared = turnCompletedUsage({ sessionUpdate: "turn_completed", usage: { costUsdTicks: 100_000_000, modelUsage: {
      "grok-4.6": { inputTokens: 300, outputTokens: 0, costUsdTicks: 40_000_000 },
      "grok-code": { inputTokens: 100, outputTokens: 100 },
      "grok-mini": { inputTokens: 200, outputTokens: 0 },
      empty: { inputTokens: 0, outputTokens: 0 },
    } } } as never)!;
    expect(shared.map((entry) => [entry.model, entry.totalTokens, Number(entry.costUsd.toFixed(4))])).toEqual([["grok-4.6", 300, 0.004], ["grok-code", 200, 0.003], ["grok-mini", 200, 0.003]]);
    expect(turnCompletedUsage({ sessionUpdate: "usage_update" })).toBeUndefined();
  });
});
