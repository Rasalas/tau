import { describe, expect, it } from "vitest";
import { skillPresentationForDraft } from "./App";

describe("optimistic skill presentation", () => {
  it("renders the runtime command already resolved by the host", () => {
    expect(skillPresentationForDraft(
      { name: "tdd", command: "/tdd", visibleText: "Fix **the parser**\n    without leaking wrappers" },
    )).toEqual({
      name: "tdd",
      command: "/tdd",
      copyText: "/tdd Fix **the parser**\n    without leaking wrappers",
    });
    expect(skillPresentationForDraft({ name: "tdd", command: "/skill:tdd", visibleText: "Fix it" })?.command).toBe("/skill:tdd");
  });
});
