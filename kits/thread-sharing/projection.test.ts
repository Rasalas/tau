import { describe, expect, it } from "vitest";
import type { UiMessage } from "tau/host-extension";
import { guestTranscript } from "./projection.js";
import { guestScript } from "./page.js";
describe("public guest projection", () => {
  it("does not copy arbitrary properties, prompts, shell, images, notices or reasoning", () => {
    const messages = [
      { id: "1", role: "user", text: "Public", timestamp: 0, secret: "SECRET", credentials: { value: "SECRET" } },
      { id: "2", role: "assistant", text: "Answer", timestamp: 0, thinking: "SECRET", hiddenToolResults: "SECRET" },
      { id: "3", role: "notice", text: "SYSTEM PROMPT", timestamp: 0 },
      { id: "4", role: "user", kind: "shell", text: "SHELL", timestamp: 0 },
      { id: "5", role: "user", excludedFromContext: true, text: "LOCAL", timestamp: 0 },
    ] as UiMessage[];
    expect(guestTranscript(messages)).toEqual({ messages: [{ role: "user", text: "Public" }, { role: "assistant", text: "Answer" }], tools: [], truncated: false });
  });
  it("bounds long rows and total text, keeping the newest messages", () => {
    const messages = Array.from({ length: 600 }, (_, i): UiMessage => ({ id: String(i), role: "assistant", text: `${i}:${"x".repeat(40_000)}`, timestamp: 0 }));
    const result = guestTranscript(messages);
    expect(result.truncated).toBe(true);
    expect(result.messages.reduce((size, message) => size + message.text.length, 0)).toBeLessThanOrEqual(200_000);
    expect(result.messages.every((message) => message.text.length <= 32_000)).toBe(true);
  });
  it("removes the fragment before storage, network access or rendering and retains literal credential regexes", () => {
    expect(guestScript.indexOf("history.replaceState")).toBeLessThan(guestScript.indexOf("localStorage"));
    expect(guestScript).toContain(String.raw`/^taug\.([a-f0-9]{24})\.[A-Za-z0-9_-]{43}$/`);
    expect(guestScript).not.toContain("innerHTML");
    expect(guestScript).toContain('credentials: "omit"');
    expect(guestScript).toContain("text.textContent = tool.output");
  });
  it("keeps public tool fields only and strips output and output metadata without opt-in", () => {
    const tool = { name: "bash", status: "done" as const, output: "Visible output", outputTruncated: true as const, args: { password: "PRIVATE" }, id: "PRIVATE", media: ["PRIVATE"], extras: { private: "PRIVATE" } };
    const activity = { tools: [tool, { ...tool, name: "mcp__tau__request_secret_file" }, { ...tool, name: "computer_use_window", output: "PRIVATE HIDDEN RESPONSE" }], truncated: false };
    expect(guestTranscript([], activity).tools).toEqual([{ name: "bash", status: "done" }, { name: "computer_use_window", status: "done" }]);
    expect(guestTranscript([], activity, true).tools).toEqual([{ name: "bash", status: "done", output: "Visible output", outputTruncated: true }, { name: "computer_use_window", status: "done" }]);
    expect(JSON.stringify(guestTranscript([], activity, true))).not.toContain("PRIVATE");
  });
  it("shares the 200,000 character budget between messages, tool names and output", () => {
    const messages = Array.from({ length: 6 }, (): UiMessage => ({ id: "id", role: "assistant", text: "m".repeat(32_000), timestamp: 0 }));
    const tools = Array.from({ length: 600 }, () => ({ name: "bash", status: "running" as const, output: "x".repeat(40_000) }));
    const result = guestTranscript(messages, { tools, truncated: false }, true);
    expect(result.truncated).toBe(true);
    expect(result.messages.reduce((n, message) => n + message.text.length, 0) + result.tools.reduce((n, tool) => n + tool.name.length + (tool.output?.length ?? 0), 0)).toBeLessThanOrEqual(200_000);
    const count = guestTranscript([], { tools, truncated: false });
    expect(count.tools).toHaveLength(500);
    expect(count.truncated).toBe(true);
    const full = guestTranscript(Array.from({ length: 500 }, () => ({ role: "user" as const, text: "Short message" })), { tools, truncated: false });
    expect(full.messages.length + full.tools.length).toBe(500);
    expect(full.truncated).toBe(true);
  });
});
