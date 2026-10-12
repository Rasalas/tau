import { expect, it } from "vitest";
import type { HostSnapshot, UiSession } from "../shared/contracts";
import { optimisticThreadSnapshot } from "./app-state";

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
