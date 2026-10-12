import { describe, expect, it } from "vitest";
import { skillPresentationForDraft } from "../workbench/app-state";

describe("optimistic skill presentation", () => {
  it("renders the runtime command already resolved by the host", () => {
    expect(skillPresentationForDraft(
      { source: "skill", name: "tdd", command: "/tdd", visibleText: "Fix **the parser**\n    without leaking wrappers" },
    )).toEqual({
      skill: {
        name: "tdd",
        command: "/tdd",
        copyText: "/tdd Fix **the parser**\n    without leaking wrappers",
      },
    });
    expect(skillPresentationForDraft({ source: "skill", name: "tdd", command: "/skill:tdd", visibleText: "Fix it" }).skill?.command).toBe("/skill:tdd");
  });

  it("gives each selected skill a chip and the message one copy text", () => {
    const presentation = skillPresentationForDraft({
      source: "skill",
      name: "tdd",
      command: "/skill:tdd",
      visibleText: "Fix it",
      additionalSkills: [{ name: "lint", command: "/skill:lint" }],
    });
    expect(presentation.skills?.map((skill) => skill.name)).toEqual(["tdd", "lint"]);
    expect(presentation.skill).toBe(presentation.skills?.[0]);
    expect(presentation.skills?.every((skill) => skill.copyText === "/skill:tdd /skill:lint Fix it")).toBe(true);
  });
});
