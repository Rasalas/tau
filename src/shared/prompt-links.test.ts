import { describe, expect, it } from "vitest";
import { parsePromptLink, PROMPT_LINK_LIMIT } from "./prompt-links.js";

describe("prompt links", () => {
  it("decodes text and context without accepting execution options", () => {
    expect(parsePromptLink("tau://new?prompt=%2Fdeploy%20%26%20%21rm%20-rf&host=h&project=ws&provider=p&model=m&send=true&attachments=file"))
      .toEqual({ prompt: "/deploy & !rm -rf", hostId: "h", project: "ws", provider: "p", model: "m", truncated: false });
  });
  it("bounds decoded text and tells the caller it was shortened", () => {
    const result = parsePromptLink(`tau://new?prompt=${"x".repeat(PROMPT_LINK_LIMIT + 1)}`)!;
    expect(result.prompt).toHaveLength(PROMPT_LINK_LIMIT);
    expect(result.truncated).toBe(true);
  });
  it("preserves Unicode, newlines, whitespace and slash commands as text", () => {
    const prompt = " /deploy\nGrüße 👋 ";
    expect(parsePromptLink(`TAU://new?${new URLSearchParams({ prompt })}`)?.prompt).toBe(prompt);
  });
  it("rejects other origins, routes, credentials, paths and empty prompts", () => {
    for (const url of ["https://new?prompt=x", "tau://new.evil?prompt=x", "tau://user@new?prompt=x", "tau://new/path?prompt=x", "tau://thread?thread=t", "tau://new?prompt=%20", "broken"]) {
      expect(parsePromptLink(url)).toBeUndefined();
    }
  });
});

it("does not cut a Unicode surrogate pair at the limit", () => {
  const result = parsePromptLink(`tau://new?${new URLSearchParams({ prompt: `${"x".repeat(PROMPT_LINK_LIMIT - 1)}👋` })}`)!;
  expect(result.prompt).toHaveLength(PROMPT_LINK_LIMIT - 1);
  expect(result.truncated).toBe(true);
});
