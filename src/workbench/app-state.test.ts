import { describe, expect, it } from "vitest";
import type { HostSnapshot, UiMessage, UiSession } from "../shared/contracts";
import { conversationMessagesFor, optimisticThreadSnapshot } from "./app-state";

it("keeps the current thread's own catalog when reopening it from the thread list", () => {
  const luna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
  const snapshot: HostSnapshot = {
    cwd: "/project", sessionId: "current", backendKind: "pi",
    model: luna, models: [luna], thinkingLevel: "medium", thinkingLevels: ["off", "medium", "high"],
    messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
  };
  // An older index can omit model metadata even though this thread's own
  // catalog has already arrived in the active snapshot.
  const target: UiSession = {
    id: "current", path: "/sessions/current.jsonl", title: "Current",
    modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 2,
  };
  const reopened = optimisticThreadSnapshot(snapshot, target, {
    sessionId: target.id, messages: [{ id: "saved", role: "user", text: "Saved message", timestamp: 1 }],
    isStreaming: false, activeTools: [],
  });
  expect(reopened.messages[0]?.text).toBe("Saved message");
  expect(reopened.model).toEqual(luna);
  expect(reopened.models).toEqual([luna]);
  expect(reopened.thinkingLevel).toBe("medium");
  expect(reopened.thinkingLevels).toEqual(["off", "medium", "high"]);
});

const message = (id: string, role: UiMessage["role"], text: string, timestamp: number, clientMessageId?: string): UiMessage => ({
  id, role, text, timestamp, ...(clientMessageId ? { clientMessageId } : {}),
});

describe("the conversation's rows", () => {
  it("puts a prompt the host has not confirmed last, whatever the phone's clock says", () => {
    const host = [message("u1", "user", "do it", 10_000), message("a1", "assistant", "On it.", 20_000)];
    // A phone a minute behind the host stamps its steer before the answer it follows.
    const steer = { scope: "session:t", message: message("local-1", "user", "and the tests", 20_000 - 60_000, "c1") };
    expect(conversationMessagesFor(host, [steer], "session:t", false).map((row) => row.id)).toEqual(["u1", "a1", "local-1"]);
    // Confirmed, the host's row takes its place, where the host appended it.
    const confirmed = [...host, message("u2", "user", "and the tests", 21_000, "c1")];
    expect(conversationMessagesFor(confirmed, [steer], "session:t", false).map((row) => row.id)).toEqual(["u1", "a1", "u2"]);
  });
});
