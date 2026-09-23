import { describe, expect, it, vi } from "vitest";
import {
  conversationText,
  excerptSummary,
  filesFromTool,
  handoffRequest,
  messagesAfter,
  withoutBlocks,
  writeSummary,
  HANDOFF_SYSTEM,
} from "./handoff.js";
import { formatBlock, splitBlock } from "./protocol.js";

const turns = (count: number, size = 10) => Array.from({ length: count }, (_, index) => ({
  id: `m${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text: `${index % 2 === 0 ? "ask" : "answer"} ${index} ${"x".repeat(size)}`,
}));

describe("the conversation a summary reads", () => {
  it("keeps the whole conversation when it fits, and leaves out notices", () => {
    const text = conversationText([
      { role: "user", text: "Fix the parser." },
      { role: "notice", text: "Model changed." },
      { role: "assistant", text: "Fixed it in parser.ts." },
    ]);
    expect(text).toBe("User: Fix the parser.\n\nAssistant: Fixed it in parser.ts.");
  });

  it("keeps the first request and the latest turns when it is too long", () => {
    const text = conversationText(turns(40, 200), 2_000);
    expect(text.length).toBeLessThanOrEqual(2_100);
    expect(text.startsWith("User: ask 0")).toBe(true);
    expect(text).toContain("[… earlier turns left out …]");
    expect(text).toContain("answer 39");
    expect(text).not.toContain("ask 20 ");
  });
});

describe("summaries", () => {
  it("asks the small model with the kit's own request", async () => {
    const complete = vi.fn(async () => "## Goal\nShip it.");
    const request = handoffRequest("User: Ship it.", { source: "“Ship” (pi · openai/gpt-5.6-luna)", cwd: "/project" });
    const written = await writeSummary(complete, { provider: "openai", id: "gpt-5.6-luna" }, request, () => "excerpt");
    expect(written).toEqual({ text: "## Goal\nShip it.", model: "openai/gpt-5.6-luna" });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ system: HANDOFF_SYSTEM, prompt: expect.stringContaining("User: Ship it.") }), { provider: "openai", id: "gpt-5.6-luna" });
  });

  it("never asks a model when no small one is reachable, and says why", async () => {
    const complete = vi.fn(async () => "never");
    const written = await writeSummary(complete, undefined, handoffRequest("x", { source: "s", cwd: "/p" }), () => "the latest turns");
    expect(complete).not.toHaveBeenCalled();
    expect(written).toEqual({ text: "the latest turns", fallback: "no small model is configured" });
  });

  it("falls back to the excerpt when the model fails", async () => {
    const written = await writeSummary(async () => { throw new Error("quota"); }, { provider: "p", id: "mini" }, handoffRequest("x", { source: "s", cwd: "/p" }), () => "excerpt");
    expect(written).toEqual({ text: "excerpt", fallback: "quota" });
  });

  it("writes an excerpt with the files a fork changed", () => {
    const excerpt = excerptSummary([{ role: "user", text: "a".repeat(700) }, { role: "assistant", text: "Done." }], ["src/a.ts"]);
    expect(excerpt).toContain("## Recent conversation");
    expect(excerpt).toContain(`${"a".repeat(600)} …`);
    expect(excerpt).toContain("## Files changed\n- src/a.ts");
  });
});

describe("blocks", () => {
  it("formats and splits a block by its first line", () => {
    const block = formatBlock("handoff_context", "Continued from “A”.", "## Goal\nB");
    expect(block).toBe("<handoff_context>\nContinued from “A”.\n\n## Goal\nB\n</handoff_context>");
    expect(splitBlock("Continued from “A”.\n\n## Goal\nB")).toEqual({ header: "Continued from “A”.", summary: "## Goal\nB" });
  });

  it("takes the handoff out of a fork's first prompt", () => {
    const prompt = `${formatBlock("handoff_context", "From A.", "Summary")}\n\nNow add tests.`;
    expect(withoutBlocks(prompt)).toBe("Now add tests.");
  });
});

describe("delta and files", () => {
  it("starts after the message a merge-back ended at", () => {
    const messages = turns(4);
    expect(messagesAfter(messages, "m1").map((message) => message.id)).toEqual(["m2", "m3"]);
    expect(messagesAfter(messages, undefined)).toHaveLength(4);
    expect(messagesAfter(messages, "gone")).toHaveLength(4);
  });

  it("reads the files an edit or a write names, and nothing a read or a failed call did", () => {
    expect(filesFromTool({ name: "edit", args: { path: "src/a.ts" }, status: "done" })).toEqual(["src/a.ts"]);
    expect(filesFromTool({ name: "write", args: { path: "src\\b.ts", paths: ["src/b.ts", "src/c.ts"] }, status: "done" })).toEqual(["src/b.ts", "src/c.ts"]);
    expect(filesFromTool({ name: "edit", args: { file_path: "/repo/src/a.ts" }, status: "done" }, "/repo/")).toEqual(["src/a.ts"]);
    expect(filesFromTool({ name: "read", args: { path: "src/a.ts" }, status: "done" })).toEqual([]);
    expect(filesFromTool({ name: "edit", args: { path: "src/a.ts" }, status: "error" })).toEqual([]);
  });
});
