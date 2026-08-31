import { describe, expect, it } from "vitest";
import { findDanglingToolCalls } from "./dangling-tool-calls.js";

const call = (id: string, name: string) => ({
  role: "assistant", content: [{ type: "toolCall", id, name, arguments: "{}" }],
});
const result = (id: string, name: string) => ({
  role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false,
});

describe("dangling tool calls", () => {
  it("finds a call that never received a result", () => {
    expect(findDanglingToolCalls([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      call("a", "read"), result("a", "read"),
      call("b", "ask_user_question"),
    ])).toEqual([{ toolCallId: "b", toolName: "ask_user_question" }]);
  });

  it("reports nothing when every call was answered", () => {
    expect(findDanglingToolCalls([call("a", "read"), result("a", "read")])).toEqual([]);
  });

  it("matches results that arrive out of order", () => {
    expect(findDanglingToolCalls([
      call("a", "read"), call("b", "bash"), result("b", "bash"), result("a", "read"),
    ])).toEqual([]);
  });

  it("reports several open calls from one turn", () => {
    expect(findDanglingToolCalls([
      { role: "assistant", content: [
        { type: "toolCall", id: "a", name: "read" },
        { type: "toolCall", id: "b", name: "grep" },
      ] },
      result("a", "read"),
    ])).toEqual([{ toolCallId: "b", toolName: "grep" }]);
  });

  it("ignores entries that are not messages", () => {
    expect(findDanglingToolCalls([null, undefined, 42, { role: "assistant" }, call("a", "read")]))
      .toEqual([{ toolCallId: "a", toolName: "read" }]);
  });

  it("falls back to a generic name when the call carries none", () => {
    expect(findDanglingToolCalls([{ role: "assistant", content: [{ type: "toolCall", id: "a" }] }]))
      .toEqual([{ toolCallId: "a", toolName: "tool" }]);
  });
});
