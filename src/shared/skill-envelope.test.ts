import { describe, expect, it } from "vitest";
import { parseKnownSkillInvocation, parseSkillEnvelope } from "./skill-envelope.js";

const commands = [{ name: "skill:tdd", source: "skill" }];

describe("shared skill envelope parser", () => {
  it("keeps an unknown shorthand as ordinary text", () => {
    expect(parseKnownSkillInvocation("/skill:missing keep this", commands)).toBeUndefined();
    expect(parseKnownSkillInvocation("$missing keep this", commands)).toBeUndefined();
  });

  it("does not close on a fenced body lookalike and preserves suffix whitespace", () => {
    const visible = "\n    keep indentation\n\n```md\n  keep fence\n```";
    const raw = [
      '<skill name="tdd" location="/private/SKILL.md">',
      "```md",
      "</skill>",
      "```",
      "</skill>",
      "",
      "",
      visible,
    ].join("\n");
    expect(parseSkillEnvelope(raw)).toMatchObject({ name: "tdd", userMessage: visible, envelope: true });
  });

  it("accepts wrapped attributes without treating an indented code sample as a wrapper", () => {
    expect(parseSkillEnvelope("  <skill\n name='tdd' location='/tmp/tdd'\n>\nbody\n  </skill>\n\nDo it"))
      .toMatchObject({ name: "tdd", userMessage: "Do it" });
    expect(parseSkillEnvelope("    <skill name=\"tdd\" location=\"/tmp\">\nbody\n</skill>\n\nDo not parse"))
      .toBeUndefined();
  });
});
