import { describe, expect, it } from "vitest";
import {
  buildOptimisticMessage,
  addOptimisticMessage,
  removeOptimisticMessage,
  retargetOptimisticMessage,
  retargetOptimisticByClientMessageId,
  removeOptimisticByClientMessageId,
} from "./submission-optimistic";

describe("submission-optimistic", () => {
  it("builds a user message with clientTurn and logicalTurnId", () => {
    const result = buildOptimisticMessage({
      text: "Hello assistant",
      attachments: [],
      sequence: 1,
      submittedAt: 1234567890,
    });

    expect(result.optimistic.role).toBe("user");
    expect(result.optimistic.text).toBe("Hello assistant");
    expect(result.optimistic.id).toBe(`local-${result.clientMessageId}`);
    expect(result.optimistic.clientTurnId).toBe("turn-1234567890-1");
    expect(result.clientTurn.clientTurnId).toBe("turn-1234567890-1");
    expect(result.clientTurn.clientMessageId).toBe(result.clientMessageId);
  });

  it("incorporates attachment names when text is empty", () => {
    const result = buildOptimisticMessage({
      text: "",
      attachments: [{ kind: "image", name: "screenshot.png", mimeType: "image/png", data: "base64", size: 1024 }],
      sequence: 0,
      submittedAt: 1000,
    });

    expect(result.optimistic.text).toBe("Attached screenshot.png");
    expect(result.optimistic.images).toEqual([{ mimeType: "image/png", data: "base64" }]);
  });

  it("prioritizes prepared prompt visible text and skill", () => {
    const result = buildOptimisticMessage({
      text: "raw text",
      prepared: {
        visibleText: "formatted prompt",
        skill: { name: "test-skill", command: "/skill", copyText: "skill" },
      } as any,
    });

    expect(result.optimistic.text).toBe("formatted prompt");
    expect(result.optimistic.skill).toEqual({ name: "test-skill", command: "/skill", copyText: "skill" });
  });

  it("adds, removes, and retargets optimistic messages in view store", () => {
    let state: any[] = [];
    const mockView: any = {
      setOptimisticMessages: (fn: (cur: any[]) => any[]) => {
        state = fn(state);
      },
    };

    const msg1: any = { id: "msg-1", clientMessageId: "cm-1" };
    const msg2: any = { id: "msg-2", clientMessageId: "cm-2" };

    addOptimisticMessage(mockView, "scope-a", msg1);
    addOptimisticMessage(mockView, "scope-a", msg2);
    expect(state).toHaveLength(2);

    retargetOptimisticMessage(mockView, "msg-1", "scope-b");
    expect(state.find((e) => e.message.id === "msg-1")?.scope).toBe("scope-b");

    retargetOptimisticByClientMessageId(mockView, "cm-2", "scope-c");
    expect(state.find((e) => e.message.id === "msg-2")?.scope).toBe("scope-c");

    removeOptimisticMessage(mockView, "msg-1");
    expect(state).toHaveLength(1);
    expect(state[0].message.id).toBe("msg-2");

    removeOptimisticByClientMessageId(mockView, "cm-2");
    expect(state).toHaveLength(0);
  });
});
