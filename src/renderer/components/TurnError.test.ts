import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { retryPrompt } from "./TurnError";

const user = (id: string, text: string, extra: Partial<UiMessage> = {}): UiMessage => ({ id, role: "user", text, timestamp: 0, ...extra });
const answer = (id: string, extra: Partial<UiMessage> = {}): UiMessage => ({ id, role: "assistant", text: "", timestamp: 0, ...extra });

describe("retryPrompt", () => {
  it("sends the prompt before the failed answer again, or the last one", () => {
    const failed = answer("a2", { error: "400" });
    const messages = [user("u1", "first"), answer("a1", { text: "ok" }), user("u2", "second <file name=\"a.ts\">x</file>"), failed];
    expect(retryPrompt(messages, failed)).toEqual({ text: "second <file name=\"a.ts\">x</file>", attachments: [] });
    expect(retryPrompt(messages, messages[1])).toEqual({ text: "first", attachments: [] });
    expect(retryPrompt(messages)).toEqual({ text: "second <file name=\"a.ts\">x</file>", attachments: [] });
    // A collapsed retry row is a copy of the answer; the id finds it.
    expect(retryPrompt([...messages, user("u3", "third")], { ...failed, error: "500" })).toEqual({ text: "second <file name=\"a.ts\">x</file>", attachments: [] });
  });

  it("keeps a skill's command and a prompt's images, not the host's placeholder", () => {
    const skill = { name: "review", command: "/skill:review", copyText: "/skill:review the diff" };
    expect(retryPrompt([user("u", "the diff", { skill }), answer("a", { error: "x" })])?.text).toBe("/skill:review the diff");
    const images = [{ mimeType: "image/png", data: "AAAA" }];
    expect(retryPrompt([user("u", "[1 image attached]", { images }), answer("a", { error: "x" })])).toEqual({
      text: "",
      attachments: [{ kind: "image", name: "image-1", mimeType: "image/png", data: "AAAA", size: 3 }],
    });
  });

  it("has nothing to send without a prompt", () => {
    expect(retryPrompt([answer("a", { error: "x" })])).toBeUndefined();
  });
});
