import { describe, expect, it } from "vitest";
import { TITLE_INSTRUCTIONS_LIMIT, TITLE_SYSTEM_PROMPT, titleInstructions, titleInstructionsError, titleSystemPrompt } from "./protocol.js";

describe("custom title instructions", () => {
  it("keeps the default prompt for absent or blank instructions", () => {
    for (const input of [undefined, "", " \n\t "]) expect(titleSystemPrompt(input)).toBe(TITLE_SYSTEM_PROMPT);
  });

  it("normalizes outer whitespace and line endings while preserving multiple lines", () => {
    expect(titleInstructions("  Lead with TAU-42.\r\nUse German.\rNo emoji. \n")).toBe("Lead with TAU-42.\nUse German.\nNo emoji.");
    expect(titleSystemPrompt("  Use German.  ")).toBe(`${TITLE_SYSTEM_PROMPT}\n\nAdditional title instructions:\nUse German.`);
  });

  it("accepts the length boundary and rejects oversized or non-text input", () => {
    expect(titleInstructions("x".repeat(TITLE_INSTRUCTIONS_LIMIT))).toHaveLength(TITLE_INSTRUCTIONS_LIMIT);
    expect(() => titleInstructions("x".repeat(TITLE_INSTRUCTIONS_LIMIT + 1))).toThrow("at most 2,000");
    for (const input of [null, true, [], {}]) expect(() => titleSystemPrompt(input)).toThrow("must be text");
  });

  it("counts normalized line endings at the length boundary in both validation paths", () => {
    const input = "a".repeat(TITLE_INSTRUCTIONS_LIMIT - 2) + "\r\nb";
    expect(titleInstructionsError(input)).toBeUndefined();
    expect(titleInstructions(input)).toBe("a".repeat(TITLE_INSTRUCTIONS_LIMIT - 2) + "\nb");
    expect(titleInstructionsError(input + "c")).toContain("at most 2,000");
    expect(() => titleInstructions(input + "c")).toThrow("at most 2,000");
  });

  it("rejects hidden control characters and allows newlines and tabs", () => {
    expect(titleInstructionsError("Use German.\n\tLead with the issue.")).toBeUndefined();
    for (const character of ["\0", "\x1b", "\x7f"]) expect(() => titleInstructions(`Use${character}German`)).toThrow("control characters");
  });
});
