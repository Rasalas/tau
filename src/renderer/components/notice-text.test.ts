import { describe, expect, it } from "vitest";
import { noticeHeadline } from "./notice-text";

/** The text a provider failure reaches the workbench as, verbatim. */
const PROVIDER_FAILURE = '400: {"type":"MissingSessionID","message":"Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it"}';

describe("noticeHeadline", () => {
  it("leaves a plain sentence alone", () => {
    expect(noticeHeadline("Branch copied.")).toBe("Branch copied.");
  });

  it("unwraps a provider payload to the sentence inside it, keeping the status", () => {
    expect(noticeHeadline(PROVIDER_FAILURE)).toBe(
      "400 · Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently. "
      + "Please see https://opencode.ai/docs/go/#where-can-i-use-it",
    );
  });

  it("unwraps a body that arrives without a status code", () => {
    expect(noticeHeadline('{"error":"Workspace is locked"}')).toBe("Workspace is locked");
  });

  it("keeps a payload it cannot read rather than inventing words", () => {
    expect(noticeHeadline('400: {"type":"MissingSessionID"}')).toBe('400: {"type":"MissingSessionID"}');
    expect(noticeHeadline('{"message":"cut off halfway')).toBe('{"message":"cut off halfway');
  });

  it("collapses a stack trace to one line and cuts it at a word boundary", () => {
    const long = `Error: boom\n    at one\n    at two\n    ${"word ".repeat(80)}end`;
    const headline = noticeHeadline(long);
    expect(headline).not.toContain("\n");
    expect(headline.length).toBeLessThanOrEqual(201);
    expect(headline.endsWith("…")).toBe(true);
    expect(headline.startsWith("Error: boom at one at two")).toBe(true);
  });
});
