import { describe, expect, it } from "vitest";
import {
  ALLOW, ALLOW_SESSION, DENY, COMPACT_AND_CONTINUE, NEVER_ASK,
  askUserQuestionAnswer, askUserQuestionPrompts, permissionPrompt, permissionResultFor, planPrompt, resumeDialogResult, sessionPermissionUpdates, summarizeToolInput,
} from "./approvals.js";

describe("Claude approvals", () => {
  it("names what a tool is about to do and offers the three answers", () => {
    expect(summarizeToolInput("Bash", { command: "  rm   -rf build ", description: "clean" })).toBe("Bash: rm -rf build");
    expect(summarizeToolInput("Read", { file_path: "/repo/a.ts" })).toBe("Read: /repo/a.ts");
    expect(summarizeToolInput("mcp__x__do", { count: 3 })).toBe('mcp__x__do: {"count":3}');
    expect(summarizeToolInput("Thing", {})).toBe("Thing");
    expect(summarizeToolInput("Bash", { command: "x".repeat(300) })).toHaveLength("Bash: ".length + 240);
    expect(permissionPrompt({ toolName: "Bash", input: { command: "ls" }, description: "List files", blockedPath: "/etc" })).toEqual({
      kind: "select",
      title: "Claude wants to run Bash",
      message: "Bash: ls\nList files\nOutside the allowed directories: /etc",
      options: [ALLOW, ALLOW_SESSION, DENY],
    });
    expect(permissionPrompt({ toolName: "Bash", input: {}, title: "Claude wants to list files", displayName: "Run command" }).title).toBe("Claude wants to list files");
  });

  it("maps the answer onto the SDK's result, and keeps a session allowance out of the settings files", () => {
    const request = { toolName: "Bash", input: { command: "ls" } };
    expect(permissionResultFor({ value: ALLOW }, request)).toEqual({ behavior: "allow", decisionClassification: "user_temporary" });
    expect(permissionResultFor({ value: DENY }, request)).toMatchObject({ behavior: "deny", decisionClassification: "user_reject" });
    expect(permissionResultFor({ value: "no, use git status instead", typed: true }, request)).toMatchObject({ behavior: "deny", message: "The user declined and said: no, use git status instead" });
    expect(permissionResultFor({ cancelled: true }, request)).toMatchObject({ behavior: "deny" });
    expect(permissionResultFor({ confirmed: true }, request)).toMatchObject({ behavior: "allow" });

    const suggested = permissionResultFor({ value: ALLOW_SESSION }, {
      ...request,
      suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "localSettings" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    });
    expect(suggested).toEqual({
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" }],
    });
    // No suggestion (MCP tools): the whole tool is allowed for the session, so the choice still sticks.
    expect(sessionPermissionUpdates(undefined, "mcp__preview__click")).toEqual([
      { type: "addRules", rules: [{ toolName: "mcp__preview__click" }], behavior: "allow", destination: "session" },
    ]);
  });

  it("turns AskUserQuestion into selects keyed by the full question text", () => {
    const prompts = askUserQuestionPrompts({
      questions: [
        { question: "Which library?", header: "Library", options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "zones" }] },
        { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "a" }, { label: "b" }] },
        { question: 42 },
      ],
    });
    expect(prompts.map((entry) => entry.prompt)).toEqual([
      { kind: "select", title: "Which library?", message: "Library", options: ["date-fns — small", "luxon — zones"] },
      { kind: "select", title: "Which features?", message: "Features · several may apply; name them all in one answer", options: ["a", "b"] },
    ]);
    expect(askUserQuestionAnswer({ value: "luxon — zones" }, prompts[0]!)).toBe("luxon");
    expect(askUserQuestionAnswer({ value: "a and b", typed: true }, prompts[1]!)).toBe("a and b");
    expect(askUserQuestionAnswer({ cancelled: true }, prompts[0]!)).toBeUndefined();
  });

  it("asks about a plan and about compacting a resumed conversation", () => {
    expect(planPrompt()).toMatchObject({ kind: "confirm", title: "Approve Claude's plan?" });
    expect(resumeDialogResult({ value: COMPACT_AND_CONTINUE })).toEqual({ behavior: "completed", result: "compact" });
    expect(resumeDialogResult({ value: NEVER_ASK })).toEqual({ behavior: "completed", result: "never" });
    expect(resumeDialogResult({ cancelled: true })).toEqual({ behavior: "cancelled" });
  });
});
