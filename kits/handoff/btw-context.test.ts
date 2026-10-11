import { describe, expect, it } from "vitest";
import { btwPrompt, fitLines, linesFromEntries, linesFromMessages } from "./btw-context.js";

const message = (id: string, body: Record<string, unknown>) => ({ type: "message", id, message: body });
const text = (value: string) => [{ type: "text", text: value }];

describe("side question context", () => {
  it("reads a Pi branch: what was said, the tools called with short arguments, and what they returned", () => {
    const lines = linesFromEntries([
      { type: "session", id: "s" },
      message("e1", { role: "system", content: "" }),
      message("e2", { role: "user", content: text("Why is the build slow?") }),
      message("e3", { role: "assistant", content: [...text("Let me look."), { type: "toolCall", name: "bash", arguments: { command: "npm run build -- --verbose", timeout: 30 } }] }),
      message("e4", { role: "toolResult", toolName: "bash", content: text(`line\n${"x".repeat(900)}`) }),
      message("e5", { role: "toolResult", toolName: "read", isError: true, content: text("ENOENT") }),
      { type: "compaction", id: "e6", summary: "Earlier we fixed lint." },
      { type: "thinking_level_change", id: "e7" },
    ]);
    expect(lines[0]).toBe("User: Why is the build slow?");
    expect(lines[1]).toBe("Assistant: Let me look.\n[called bash: npm run build -- --verbose]");
    expect(lines[2]).toMatch(/^\[bash returned: line x+ …\]$/u);
    expect(lines[2]!.length).toBeLessThan(640);
    expect(lines[3]).toBe("[read failed: ENOENT]");
    expect(lines[4]).toBe("Summary of earlier turns: Earlier we fixed lint.");
    expect(lines).toHaveLength(5);
  });

  it("reads the visible messages of a runtime without a journal", () => {
    expect(linesFromMessages([
      { role: "user", text: "Hi" },
      { role: "assistant", text: "  " },
      { role: "notice", text: "Compacted" },
      { role: "assistant", text: "Hello" },
    ] as never)).toEqual(["User: Hi", "Assistant: Hello"]);
  });

  it("keeps the first request and the latest turns when the conversation is too long", () => {
    const lines = ["User: Build the parser.", ...Array.from({ length: 40 }, (_, index) => `Assistant: step ${index} ${"y".repeat(100)}`)];
    const fitted = fitLines(lines, 1_000);
    expect(fitted.startsWith("User: Build the parser.\n\n[… earlier turns left out …]")).toBe(true);
    expect(fitted).toContain("step 39");
    expect(fitted).not.toContain("step 0 ");
    expect(fitLines(lines.slice(0, 3), 10_000)).toBe(lines.slice(0, 3).join("\n\n"));
  });

  it("builds the prompt, and says when the agent is mid-turn", () => {
    const prompt = btwPrompt({ context: "User: Hi", question: " What now? ", cwd: "/p", working: true });
    expect(prompt).toContain("<conversation>\nUser: Hi\n</conversation>");
    expect(prompt).toContain("still working");
    expect(prompt.endsWith("Question: What now?")).toBe(true);
    expect(btwPrompt({ context: "", question: "Q", cwd: "/p", working: false })).toContain("(nothing has been said yet)");
  });
});
