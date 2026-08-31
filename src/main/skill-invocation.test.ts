import { describe, expect, it } from "vitest";
import type { UiComposerCommand } from "../shared/contracts.js";
import {
  prepareSkillPrompt,
  normalizeSkillInvocationForRuntime,
  normalizePiBridgePrompt,
  PI_RUNTIME_ADAPTER,
  skillMessagePresentation,
  visibleSkillEnvelopeText,
  type SkillRuntimeAdapter,
} from "./skill-invocation.js";

const commands: UiComposerCommand[] = [
  { name: "skill:tdd", source: "skill", description: "Build features test-first" },
  { name: "review", source: "prompt", description: "Review changes" },
];

const claudeCodeAdapter: SkillRuntimeAdapter = {
  capabilities: { skillInvocationDialect: "claude-code" },
};

const expanded = `<skill location="/Users/me/.pi/skills/tdd/SKILL.md" name="tdd">
References are relative to /Users/me/.pi/skills/tdd.

Injected instructions that must never leak into the UI.
</skill>

Review **the parser** and preserve this Markdown.`;

describe("skill runtime boundary", () => {
  it("maps an expanded envelope to visible text and typed metadata", () => {
    const presentation = skillMessagePresentation(expanded, PI_RUNTIME_ADAPTER, commands);
    expect(presentation).toEqual({
      text: "Review **the parser** and preserve this Markdown.",
      skill: {
        name: "tdd",
        command: "/skill:tdd",
        copyText: "/skill:tdd Review **the parser** and preserve this Markdown.",
      },
    });
    expect(presentation?.text).not.toContain("Injected instructions");
    expect(presentation?.text).not.toContain("References are relative");
    expect(presentation?.skill.copyText).not.toContain("/Users/me/.pi/skills");
    expect(visibleSkillEnvelopeText(expanded)).toBe("Review **the parser** and preserve this Markdown.");
  });

  it("preserves user line whitespace, including indented and fenced Markdown", () => {
    const instruction = "Review this:\n    keep this indentation\n\n```md\n  keep this fence\n```";
    const text = `<skill name="tdd" location="/tmp/tdd">\nbody\n</skill>\n\n${instruction}`;
    expect(skillMessagePresentation(text, PI_RUNTIME_ADAPTER, commands)?.text).toBe(instruction);
    expect(normalizeSkillInvocationForRuntime(text, PI_RUNTIME_ADAPTER, commands)).toBe(`/skill:tdd ${instruction}`);

    const leadingWhitespace = "\n    keep this leading line break";
    const leadingText = `<skill name="tdd" location="/tmp/tdd">\nbody\n</skill>\n\n\n${leadingWhitespace}`;
    expect(skillMessagePresentation(leadingText, PI_RUNTIME_ADAPTER, commands)?.text).toBe(leadingWhitespace);
    expect(normalizeSkillInvocationForRuntime(leadingText, PI_RUNTIME_ADAPTER, commands)).toBe(`/skill:tdd ${leadingWhitespace}`);
  });

  it("does not close an envelope on a top-level-looking tag inside a fenced body", () => {
    const text = "<skill name=\"tdd\" location=\"/tmp/tdd\">\n```md\n</skill>\n```\n</skill>\n\nKeep this example.";
    expect(skillMessagePresentation(text, PI_RUNTIME_ADAPTER, commands)?.text).toBe("Keep this example.");
  });

  it("recognizes a structurally valid envelope with wrapped attributes", () => {
    const text = "  <skill\n    location=\"/tmp/tdd\"\n    name=\"tdd\"\n  >\nbody\n</skill>\n\nKeep this example.";
    expect(skillMessagePresentation(text, PI_RUNTIME_ADAPTER, commands)?.text).toBe("Keep this example.");
    expect(normalizeSkillInvocationForRuntime(text, PI_RUNTIME_ADAPTER, commands)).toBe("/skill:tdd Keep this example.");
  });

  it("recognizes an envelope after Markdown-safe leading blank lines", () => {
    const text = "\n  <skill name=\"tdd\" location=\"/tmp/tdd\">\nbody\n  </skill>\n\nKeep this example.";
    expect(skillMessagePresentation(text, PI_RUNTIME_ADAPTER, commands)?.text).toBe("Keep this example.");
  });

  it("uses the explicit runtime adapter dialect, independent of model provider ids", () => {
    expect(normalizeSkillInvocationForRuntime("$tdd fix it", PI_RUNTIME_ADAPTER, commands)).toBe("/skill:tdd fix it");
    expect(normalizeSkillInvocationForRuntime("/tdd fix it", PI_RUNTIME_ADAPTER, commands)).toBe("/skill:tdd fix it");
    expect(normalizeSkillInvocationForRuntime("$tdd fix it", claudeCodeAdapter, commands)).toBe("/tdd fix it");
    expect(normalizeSkillInvocationForRuntime("/skill:tdd fix it", claudeCodeAdapter, commands)).toBe("/tdd fix it");
  });

  it("normalizes bridge delivery in the Pi runtime owner", () => {
    expect(normalizePiBridgePrompt("$tdd fix it", commands)).toBe("/skill:tdd fix it");
    expect(normalizePiBridgePrompt("    /tdd keep this code", commands)).toBe("    /tdd keep this code");
  });

  it("keeps unknown, malformed, and code-block lookalikes lossless", () => {
    const unknown = expanded.replace('name="tdd"', 'name="missing"');
    const malformed = expanded.replace("</skill>", "</skill");
    const fenced = `\`\`\`xml\n${expanded}\n\`\`\``;
    const indented = `    /tdd do not rewrite this code`;
    const indentedEnvelope = `  ${expanded}`;
    for (const text of [unknown, malformed, fenced, indented]) {
      expect(normalizeSkillInvocationForRuntime(text, claudeCodeAdapter, commands)).toBe(text);
      expect(skillMessagePresentation(text, claudeCodeAdapter, commands)).toBeUndefined();
    }
    expect(normalizeSkillInvocationForRuntime(indentedEnvelope, claudeCodeAdapter, commands)).toBe("/tdd Review **the parser** and preserve this Markdown.");
  });

  it("does not steal a colliding slash command from an extension or prompt", () => {
    const collision = [
      ...commands,
      { name: "skill:review", source: "skill" as const },
    ];
    expect(normalizeSkillInvocationForRuntime("/review this", claudeCodeAdapter, collision)).toBe("/review this");
  });

  it("keeps selected skill metadata authoritative over a colliding raw command", () => {
    const collision = [
      ...commands,
      { name: "tdd", source: "extension" as const, description: "An extension command with the same spelling" },
    ];
    const prepared = prepareSkillPrompt(
      "/tdd inspect this",
      claudeCodeAdapter,
      collision,
      { source: "skill", name: "tdd", visibleText: "inspect this", command: "/tdd" },
    );
    expect(prepared).toMatchObject({
      text: "inspect this",
      runtimeText: "/tdd inspect this",
      skill: { name: "tdd", command: "/tdd" },
    });
  });

  it("rejects selected metadata from a non-skill source", () => {
    expect(() => prepareSkillPrompt(
      "/tdd inspect this",
      claudeCodeAdapter,
      commands,
      { source: "extension" as never, name: "tdd", visibleText: "inspect this", command: "/tdd" },
    )).toThrow("no longer available");
  });
});
