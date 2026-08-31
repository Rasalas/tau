import { describe, expect, it } from "vitest";
import { choiceOptions, freeTextOption, splitPromptTitle } from "./extension-prompt-options.js";

describe("extension prompt options", () => {
  const options = ["1. Red — Choose red.", "2. Blue — Choose blue.", "3. Type something."];

  it("finds the free-text row in any supported language", () => {
    expect(freeTextOption(options)).toBe("3. Type something.");
    expect(freeTextOption(["1. Rot", "2. Schreibe etwas."])).toBe("2. Schreibe etwas.");
    expect(freeTextOption(["Yes", "No"])).toBeUndefined();
  });

  it("takes option previews back out of a folded select title", () => {
    const title = "[UI] Which layout?\n\n--- 1. Sidebar preview ---\n| nav | main |\n\n--- 2. Tabs preview ---\n[ tab ][ tab ]";
    expect(splitPromptTitle(title)).toEqual({
      question: "[UI] Which layout?",
      previews: [
        { index: 1, label: "Sidebar", text: "| nav | main |" },
        { index: 2, label: "Tabs", text: "[ tab ][ tab ]" },
      ],
    });
    expect(splitPromptTitle("Plain question?")).toEqual({ question: "Plain question?", previews: [] });
  });

  it("hides the free-text row from the clickable choices", () => {
    expect(choiceOptions(options)).toEqual(options.slice(0, 2));
    expect(choiceOptions(["Yes", "No"])).toEqual(["Yes", "No"]);
  });
});
