import { describe, expect, it } from "vitest";
import {
  compactSkillInvocation,
  formatSkillInvocation,
  normalizeSkillInvocationForProvider,
  parseSkillEnvelope,
  parseSkillInvocation,
  parseSkillReference,
  skillProviderSyntax,
} from "./skill-invocation.js";

const commands = [
  { name: "skill:tdd", source: "skill" as const },
  { name: "review", source: "prompt" as const },
];

const expanded = `<skill location="/Users/me/.pi/skills/tdd/SKILL.md" name="tdd">
References are relative to /Users/me/.pi/skills/tdd.

Injected instructions that must not appear in the timeline.
</skill>

Fix **the parser** and keep the examples intact.`;

describe("skill invocation parsing", () => {
  it("extracts the user instruction from a Pi skill envelope", () => {
    expect(parseSkillInvocation(expanded, commands)).toMatchObject({
      kind: "expanded",
      name: "tdd",
      location: "/Users/me/.pi/skills/tdd/SKILL.md",
      userMessage: "Fix **the parser** and keep the examples intact.",
    });
    expect(parseSkillEnvelope(expanded)?.body).toContain("Injected instructions");
  });

  it("handles CRLF envelopes without changing the visible instruction", () => {
    const text = expanded.replaceAll("\n", "\r\n");
    expect(parseSkillInvocation(text, commands)?.userMessage).toBe("Fix **the parser** and keep the examples intact.");
  });

  it("keeps unknown, malformed, and code-looking wrappers lossless", () => {
    const unknown = expanded.replace('name="tdd"', 'name="missing"');
    const malformed = expanded.replace("</skill>", "</skill");
    const fenced = `\`\`\`xml\n${expanded}\n\`\`\``;
    expect(parseSkillInvocation(unknown, commands)).toBeUndefined();
    expect(compactSkillInvocation(unknown, "claude-code", commands)).toBe(unknown);
    expect(compactSkillInvocation(malformed, "claude-code", commands)).toBe(malformed);
    expect(parseSkillInvocation(fenced, commands)).toBeUndefined();
    expect(compactSkillInvocation(fenced, "claude-code", commands)).toBe(fenced);
    expect(parseSkillReference(`    /tdd fix`, commands)).toBeUndefined();
  });

  it("does not mistake a command-looking token after prose for a skill", () => {
    expect(parseSkillReference("Please run /tdd now", commands)).toBeUndefined();
    expect(parseSkillReference("/review now", commands)).toBeUndefined();
  });

  it("recognizes shorthand and canonical Pi references only for known skills", () => {
    expect(parseSkillReference("$tdd fix **this**", commands)).toMatchObject({
      kind: "reference",
      name: "tdd",
      syntax: "dollar",
      userMessage: "fix **this**",
    });
    expect(parseSkillReference("/skill:tdd fix", commands)).toMatchObject({
      name: "tdd",
      syntax: "pi",
      userMessage: "fix",
    });
    expect(parseSkillReference("/review now", [
      ...commands,
      { name: "skill:review", source: "skill" as const },
    ])).toBeUndefined();
  });
});

describe("provider-aware skill invocation", () => {
  it("uses Claude Code's slash command and never emits dollar syntax", () => {
    expect(skillProviderSyntax("claude-code")).toBe("claude-code");
    expect(skillProviderSyntax("claude_code")).toBe("claude-code");
    expect(formatSkillInvocation("tdd", "fix the parser", "claude-code")).toBe("/tdd fix the parser");
    expect(normalizeSkillInvocationForProvider("$tdd fix the parser", "claude-code", commands)).toBe("/tdd fix the parser");
    expect(normalizeSkillInvocationForProvider("/skill:tdd fix the parser", "claude-code", commands)).toBe("/tdd fix the parser");
  });

  it("keeps Pi's canonical syntax for non-Claude providers", () => {
    expect(normalizeSkillInvocationForProvider("$tdd fix the parser", "anthropic", commands)).toBe("/skill:tdd fix the parser");
    expect(normalizeSkillInvocationForProvider("/tdd fix the parser", "openai", commands)).toBe("/skill:tdd fix the parser");
    expect(compactSkillInvocation(expanded, "anthropic", commands)).toBe("/skill:tdd Fix **the parser** and keep the examples intact.");
  });

  it("preserves the exact input when a known skill cannot be established", () => {
    const text = "$missing do not rewrite me";
    expect(normalizeSkillInvocationForProvider(text, "claude-code", commands)).toBe(text);
  });
});
