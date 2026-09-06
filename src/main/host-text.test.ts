import { describe, expect, it } from "vitest";
import { buildTitleConversation, cleanThreadTitle } from "./host-text.js";

describe("cleanThreadTitle", () => {
  it("removes Markdown and title-model framing", () => {
    expect(cleanThreadTitle("## **Thread title: `Persist Turn Activity`**\nExtra explanation")).toBe("Persist Turn Activity");
    expect(cleanThreadTitle("Titel: [Sidebar-Namen](https://example.test).")).toBe("Sidebar-Namen");
  });
});

describe("the conversation a title is made from", () => {
  it("titles a persisted conversation when the fresh runtime buffer is not ready", () => {
    expect(buildTitleConversation([], [
      { role: "user", content: "Persisted question" },
      { role: "assistant", content: [{ type: "text", text: "Persisted answer" }] },
    ])).toBe("user: Persisted question\n\nassistant: Persisted answer");
  });

  it("skips non-text assistant records before applying the title context limit", () => {
    const toolOnly = { role: "assistant", content: [{ type: "toolCall", name: "read" }] };
    expect(buildTitleConversation([
      toolOnly, toolOnly, toolOnly, toolOnly,
      { role: "user", content: "Visible request" },
    ])).toBe("user: Visible request");
  });

  it("removes runtime skill wrappers from fallback title context", () => {
    const wrapper = `<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions\n</skill>\n\nReview the parser`;
    const conversation = buildTitleConversation([{ role: "user", content: wrapper, skill: { name: "tdd", command: "/skill:tdd" } }]);
    expect(conversation).toBe("user: Review the parser");
    expect(conversation).not.toContain("Injected instructions");
    expect(conversation).not.toContain("/Users/me/.pi/skills");
  });

  it("uses a sanitized fallback for malformed runtime wrappers", () => {
    for (const malformed of [
      `<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions\n</skill`,
      `<skill\nname="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions`,
      `\n  <skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions`,
    ]) {
      const conversation = buildTitleConversation([{ role: "user", content: malformed }]);
      expect(conversation).toBe("user: Skill invocation");
      expect(conversation).not.toContain("Injected instructions");
      expect(conversation).not.toContain("/Users/me/.pi/skills");
    }
  });
});
