import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TurnCheckpointLifecycle } from "./turn-checkpoint-lifecycle.js";
import { assistantAnchorForBranch, createPiTurnCheckpointExtension } from "./pi-turn-checkpoint-extension.js";

describe("Pi turn checkpoint anchors", () => {
  it("starts capturing future inputs after promotion without replacing the runtime", async () => {
    let enabled = false;
    const callbacks = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void>>();
    const acceptInput = vi.fn(async () => undefined);
    const lifecycle = { nextInputTurnId: () => undefined, acceptInput } as unknown as TurnCheckpointLifecycle<unknown>;
    const pi = { on: (name: string, callback: (event: unknown, context: ExtensionContext) => Promise<void>) => callbacks.set(name, callback) } as unknown as ExtensionAPI;
    createPiTurnCheckpointExtension({ lifecycle, enabled: () => enabled, nextTurnId: () => "future-turn", findAssistantAnchor: () => undefined })(pi);
    const input = callbacks.get("input")!;
    await input({}, {} as ExtensionContext);
    expect(acceptInput).not.toHaveBeenCalled();
    enabled = true;
    await input({}, {} as ExtensionContext);
    expect(acceptInput).toHaveBeenCalledWith("future-turn", { deferBefore: false });
  });

  it("prefers the exact persisted assistant object over a timestamp collision", () => {
    const first = { role: "assistant", timestamp: 10, stopReason: "stop" };
    const second = { role: "assistant", timestamp: 10, stopReason: "stop" };
    const branch = [
      { type: "message", id: "first-entry", message: first },
      { type: "message", id: "second-entry", message: second },
    ];

    expect(assistantAnchorForBranch(branch, second)).toBe("second-entry");
  });

  it("falls back to the latest matching assistant for adapted event payloads", () => {
    const branch = [{
      type: "message",
      id: "assistant-entry",
      message: { role: "assistant", timestamp: 10, stopReason: "stop" },
    }];

    expect(assistantAnchorForBranch(branch, { role: "assistant", timestamp: 10, stopReason: "stop" }))
      .toBe("assistant-entry");
  });
});
