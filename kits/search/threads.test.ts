import { describe, expect, it } from "vitest";
import { THREAD_FIND_LIMIT } from "./protocol.js";
import { findInThread, findMessages, queryTokens, sessionText, THREAD_TEXT_LIMIT } from "./threads.js";

const message = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
const find = (content: string, query: string) => findInThread(sessionText(content), queryTokens(query), query.toLowerCase());

describe("cached session text", () => {
  it("keeps both ends of a long thread, including recent messages after the old prefix cap", () => {
    const content = [
      message("user", "opening nebula"),
      message("assistant", "x".repeat(THREAD_TEXT_LIMIT)),
      message("user", "recent quasar"),
      message("toolResult", "hidden comet"),
      '{"type":"message","message":',
    ].join("\n");
    const texts = sessionText(content);
    expect(texts.reduce((sum, entry) => sum + entry.text.length, 0)).toBe(THREAD_TEXT_LIMIT);
    expect(find(content, "nebula")).toMatchObject({ role: "user", snippet: "opening nebula" });
    expect(find(content, "quasar")).toMatchObject({ role: "user", snippet: "recent quasar" });
    expect(find(content, "comet")).toBeUndefined();
  });

  it("bounds a single oversized message and never joins text across the omitted middle", () => {
    const content = message("assistant", `opening nebula ${"x".repeat(THREAD_TEXT_LIMIT * 2)} recent quasar`);
    const texts = sessionText(content);
    expect(texts.reduce((sum, entry) => sum + entry.text.length, 0)).toBe(THREAD_TEXT_LIMIT);
    expect(find(content, "quasar")?.snippet).toContain("recent quasar");
    expect(find(content, "nebula quasar")).toBeUndefined();
  });

  it("preserves a whole message crossing the halfway point while the entire thread fits", () => {
    const content = [message("user", "x".repeat(THREAD_TEXT_LIMIT / 2 - 5)), message("assistant", "nebula quasar")].join("\n");
    expect(find(content, "nebula quasar")).toMatchObject({ role: "assistant", snippet: "nebula quasar" });
  });

  it("retains a bounded chronological window while many small messages displace the middle", () => {
    const content = Array.from({ length: 6_000 }, (_, at) => message("user", `marker-${String(at).padStart(5, "0")} ${"x".repeat(100)}`)).join("\n");
    expect(sessionText(content).reduce((sum, entry) => sum + entry.text.length, 0)).toBe(THREAD_TEXT_LIMIT);
    expect(find(content, "marker-00000")).toBeDefined();
    expect(find(content, "marker-03000")).toBeUndefined();
    expect(find(content, "marker-05999")).toBeDefined();
  });

  it("reads whitespace-formatted JSON and searches visible text rather than thinking or tool output", () => {
    const content = JSON.stringify({ type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "hidden comet" }, { type: "text", text: "Visible quasar" },
    ] } }, null, 0).replaceAll(":", ": ");
    expect(find(content, "quasar")).toMatchObject({ snippet: "Visible quasar" });
    expect(find(content, "comet")).toBeUndefined();
  });
});

describe("findInThread", () => {
  it("chooses a useful whole-word snippet over an earlier incidental substring", () => {
    const texts = [{ role: "user" as const, text: "An oauth redirect" }, { role: "assistant" as const, text: "Fix auth tokens" }];
    expect(findInThread(texts, ["auth"], "auth")).toMatchObject({ role: "assistant", snippet: "Fix auth tokens", quality: 31 });
    expect(findInThread(texts, ["oauth"], "oauth")).toMatchObject({ role: "user" });
    const repeated = [{ role: "user" as const, text: `oauth ${"x".repeat(200)} fix auth tokens` }];
    expect(findInThread(repeated, ["auth"], "auth")?.snippet).toContain("fix auth tokens");
  });
});

describe("findMessages", () => {
  it("resolves the global snippet's best separated-token message, with earliest ties and no reasoning or cross-message tokens", () => {
    const messages = [
      { id: "substring", role: "user", text: "quartzite and moonlight" },
      { id: "first", role: "assistant", text: "Quartz beside the moon" },
      { id: "tie", role: "user", text: "the moon contains quartz" },
      { id: "thinking", role: "assistant", text: "quartz", thinking: "moon" },
      { id: "notice", role: "notice", text: "quartz moon" },
      { id: "other", role: "user", text: "moon" },
    ];
    expect(findMessages(messages, "  QUARTZ\tmoon ", "all-words")).toEqual({ messageIds: ["first"], truncated: false });
    expect(findMessages(messages, "quartz moon")).toEqual({ messageIds: [], truncated: false });
    expect(findMessages(messages.slice(3), "quartz moon", "all-words").messageIds).toEqual([]);
    expect(findMessages([...messages, { id: "phrase", role: "user", text: "quartz moon" }], "quartz moon", "all-words").messageIds).toEqual(["phrase"]);
    expect(findMessages(messages, " ", "all-words").messageIds).toEqual([]);
    const global = findInThread(messages.filter(m => m.role === "user" || m.role === "assistant") as Array<{ role: "user" | "assistant"; text: string }>, queryTokens("quartz moon"), "quartz moon");
    expect(global?.snippet).toBe(messages[1]!.text);
  });

  it("names the user and assistant messages holding the query in their words or reasoning", () => {
    const messages = [
      { id: "1", role: "user", text: "Quartz?" },
      { id: "2", role: "assistant", text: "", thinking: "a quartz idea" },
      { id: "3", role: "notice", text: "quartz" },
      { id: "4", role: "assistant" },
    ];
    expect(findMessages(messages, "QUARTZ")).toEqual({ messageIds: ["1", "2"], truncated: false });
  });

  it("keeps the newest matches of a thread that has more than it will name", () => {
    const messages = Array.from({ length: THREAD_FIND_LIMIT + 5 }, (_, index) => ({ id: String(index), role: "user", text: "hit" }));
    const found = findMessages(messages, "hit");
    expect(found.messageIds).toHaveLength(THREAD_FIND_LIMIT);
    expect(found).toMatchObject({ truncated: true });
    expect(found.messageIds[0]).toBe("5");
  });
});
