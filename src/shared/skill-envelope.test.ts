import { describe, expect, it } from "vitest";
import { parseKnownSkillInvocation, parseKnownSkillName, parseSelectedSkillRun, parseSkillEnvelope } from "./skill-envelope.js";

const commands = [{ name: "skill:tdd", source: "skill" }, { name: "skill:lint", source: "skill" }, { name: "review", source: "prompt" }];

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

  describe("several skills in one message", () => {
    const block = (name: string) => `<skill name="${name}" location="/skills/${name}/SKILL.md">\nbody of ${name}\n</skill>`;

    it("reads a run of envelopes as one and leaves the text as typed", () => {
      const raw = `${block("tdd")}\n\n${block("lint")}\n\n  Fix it\n\n\nand then more`;
      expect(parseSkillEnvelope(raw)).toMatchObject({ name: "tdd", names: ["tdd", "lint"], userMessage: "  Fix it\n\n\nand then more" });
      expect(parseKnownSkillInvocation(raw, commands)).toMatchObject({ names: ["tdd", "lint"], userMessage: "  Fix it\n\n\nand then more" });
    });

    it("stops the run at a skill the host does not know", () => {
      const raw = `${block("tdd")}\n\n${block("other")}\n\nText`;
      expect(parseKnownSkillInvocation(raw, commands)).toMatchObject({ names: ["tdd"], userMessage: `${block("other")}\n\nText` });
      expect(parseSkillEnvelope(raw)?.names).toEqual(["tdd", "other"]);
    });

    it("reads leading shorthands only for a runtime that loads them all", () => {
      expect(parseKnownSkillInvocation("$tdd $lint  keep this", commands, { multiple: true }))
        .toMatchObject({ name: "tdd", names: ["tdd", "lint"], userMessage: " keep this" });
      expect(parseKnownSkillInvocation("/skill:tdd /lint go", commands, { multiple: true })).toMatchObject({ names: ["tdd", "lint"], userMessage: "go" });
      expect(parseKnownSkillInvocation("$tdd $lint keep this", commands)).toMatchObject({ names: ["tdd"], userMessage: "$lint keep this" });
    });

    it("ends the run at the first word that is not a known skill and does not repeat a name", () => {
      expect(parseKnownSkillInvocation("$tdd $nope $lint", commands, { multiple: true })).toMatchObject({ names: ["tdd"], userMessage: "$nope $lint" });
      expect(parseKnownSkillInvocation("$tdd $tdd x", commands, { multiple: true })).toMatchObject({ names: ["tdd"], userMessage: "x" });
      expect(parseKnownSkillInvocation("$tdd /review x", commands, { multiple: true })).toMatchObject({ names: ["tdd"], userMessage: "/review x" });
    });

    it("reads a selection's leading run whatever else is named", () => {
      expect(parseSelectedSkillRun("$tdd $lint rest $tdd", new Set(["tdd", "lint"]))).toMatchObject({ names: ["tdd", "lint"], userMessage: "rest $tdd" });
      expect(parseSelectedSkillRun("Use $tdd", new Set(["tdd"]))).toBeUndefined();
      expect(parseKnownSkillName("$a $b x", ["a", "b"], { multiple: true })).toMatchObject({ names: ["a", "b"], userMessage: "x" });
    });
  });
});
