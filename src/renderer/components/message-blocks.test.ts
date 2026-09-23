import { describe, expect, it } from "vitest";
import { splitMessageBlocks } from "./message-blocks";

describe("splitMessageBlocks", () => {
  it("leaves a reply without a registered tag as one text part", () => {
    expect(splitMessageBlocks("Hello <b>there</b>", ["proposed_plan"])).toEqual([{ kind: "text", text: "Hello <b>there</b>" }]);
    expect(splitMessageBlocks("<note>\nx\n</note>", ["proposed_plan"])).toEqual([{ kind: "text", text: "<note>\nx\n</note>" }]);
  });

  it("cuts a tagged block out of the text around it", () => {
    const text = "Here is the plan.\n\n<proposed_plan>\n# Add login\n\n1. Form\n</proposed_plan>\n\nSay go.";
    expect(splitMessageBlocks(text, ["proposed_plan"])).toEqual([
      { kind: "text", text: "Here is the plan.\n" },
      { kind: "block", tag: "proposed_plan", body: "# Add login\n\n1. Form", complete: true },
      { kind: "text", text: "\nSay go." },
    ]);
  });

  it("keeps a block open while its closing tag has not streamed in", () => {
    expect(splitMessageBlocks("<proposed_plan>\n# Plan\n- one", ["proposed_plan"])).toEqual([
      { kind: "block", tag: "proposed_plan", body: "# Plan\n- one", complete: false },
    ]);
  });

  it("ignores a tag inside a code fence or inside a line", () => {
    const fenced = "```xml\n<proposed_plan>\n```\nText <proposed_plan> inline";
    expect(splitMessageBlocks(fenced, ["proposed_plan"])).toEqual([{ kind: "text", text: fenced }]);
  });
});
