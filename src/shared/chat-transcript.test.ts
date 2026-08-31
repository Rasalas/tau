import { describe, expect, it } from "vitest";
import { formatChatTranscript } from "./chat-transcript.js";

describe("formatChatTranscript", () => {
  it("exports readable role sections while omitting reasoning and tool payloads", () => {
    const markdown = formatChatTranscript({
      title: "# Fix export flow",
      cwd: "/repo",
      sessionId: "session",
      exportedAt: new Date("2026-08-30T12:00:00.000Z"),
      messages: [
        { role: "user", content: [{ type: "text", text: "Please fix it." }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "toolCall", name: "read" }] },
        { role: "toolResult", content: [{ type: "text", text: "large output" }] },
        { role: "assistant", content: [{ type: "text", text: "Done.\n\n```ts\nconst ok = true;\n```" }] },
      ],
    });

    expect(markdown).toContain("# Fix export flow");
    expect(markdown).toContain("## User\n\nPlease fix it.");
    expect(markdown).toContain("## Assistant\n\nDone.\n\n```ts");
    expect(markdown).not.toContain("secret");
    expect(markdown).not.toContain("large output");
  });
});
