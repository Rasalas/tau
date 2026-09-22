import { describe, expect, it } from "vitest";
import { buildHistory, recallablePrompt, stepHistory, type HistoryPosition } from "./history.js";

describe("recallable prompts", () => {
  it("drops the context Composer Context sent ahead of the text", () => {
    const sent = [
      '<file path="src/a.ts" lines="1-2">\none\n\ntwo\n</file>',
      "From Terminal:\n> $ ls\n> a b",
      "Pull request [#4](https://example.test/pr/4): Chips",
      "The user attached big.bin (application/octet-stream, 2.0 MB). It is at /state/big.bin; read it from there.",
      '<file path="gone.ts" unavailable="not read" />',
      "explain this",
    ].join("\n\n");
    expect(recallablePrompt(sent)).toBe("explain this");
    expect(recallablePrompt("From memory: this is my own text")).toBe("From memory: this is my own text");
  });

  it("keeps a skill invocation as the command that runs it again", () => {
    expect(recallablePrompt('<skill name="review" location="/s/review.md">\nBody\n</skill>\n\nlook at main')).toBe("/skill:review look at main");
  });

  it("lists each prompt once, where it was sent last, thread before project", () => {
    expect(buildHistory(["b", "a", "b"], ["c", "a", ""])).toEqual(["b", "a", "c"]);
  });
});

describe("stepping through recall", () => {
  const entries = ["newest", "middle", "oldest"];
  const walk = (keys: Array<"back" | "forward" | "clear">, text = "") => {
    let position: HistoryPosition | undefined;
    const seen: Array<string | undefined> = [];
    for (const key of keys) {
      const step = stepHistory(key, entries, position, text);
      seen.push(step?.text);
      if (step) { position = step.position; text = step.text; }
    }
    return seen;
  };

  it("walks back from an empty composer, stops at the oldest, and walks forward to empty", () => {
    expect(walk(["back", "back", "back", "back", "forward", "forward", "forward"])).toEqual(["newest", "middle", "oldest", "oldest", "middle", "newest", ""]);
  });

  it("clears on Escape, and leaves keys alone once the recalled text was edited", () => {
    expect(walk(["back", "clear"])).toEqual(["newest", ""]);
    expect(stepHistory("back", entries, undefined, "typed")).toBeUndefined();
    expect(stepHistory("forward", entries, { index: 0, recalled: "newest" }, "newest, edited")).toBeUndefined();
    expect(stepHistory("clear", entries, undefined, "")).toBeUndefined();
    expect(stepHistory("back", [], undefined, "")).toBeUndefined();
  });

  it("finds the recalled entry again when the list grew in front of it", () => {
    const grown = ["brand new", ...entries];
    expect(stepHistory("back", grown, { index: 1, recalled: "middle" }, "middle")).toEqual({ position: { index: 3, recalled: "oldest" }, text: "oldest" });
  });
});
