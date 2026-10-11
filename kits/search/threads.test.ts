import { describe, expect, it } from "vitest";
import { THREAD_FIND_LIMIT } from "./protocol.js";
import { findMessages } from "./threads.js";

describe("findMessages", () => {
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
