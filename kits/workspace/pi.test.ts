import { describe, expect, it, vi } from "vitest";
import type { PiKitBridge } from "tau/host-extension";
import { TURN_CHECKPOINT_CUSTOM_TYPE } from "./turn-checkpoint-codec.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";
import { CHECKPOINT_EVENT } from "./protocol.js";
import workspacePiExtension from "./pi.js";

const checkpoint: UiTurnCheckpoint = {
  id: "turn-1",
  turnId: "turn-1",
  sessionId: "session",
  anchorMessageId: "assistant-entry",
  beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
  afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
  startedAt: 10,
  endedAt: 20,
  files: [{ path: "src/app.ts", name: "app.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1,
  removed: 0,
  branch: "main",
};

function harness() {
  const commands = new Map<string, (ctx: any, input: Record<string, unknown>) => Promise<unknown>>();
  const events = new Map<string, (event: any, ctx: any) => unknown>();
  const published: Array<{ name: string; payload: unknown }> = [];
  const pins: Array<(ctx: any) => readonly string[]> = [];
  const turns: any[] = [];
  const branch: unknown[] = [
    { type: "message", id: "assistant-entry", message: { role: "assistant", content: [] } },
    { type: "custom", id: "custom-1", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: checkpoint },
  ];
  const context = {
    cwd: "/project",
    mode: "tui",
    sessionManager: { getSessionId: () => "session", getSessionFile: () => "/sessions/session.jsonl", getBranch: () => branch },
    ui: { notify: vi.fn() },
  };
  const bridge = {
    extensionId: "tau.workspace",
    registerCommand: (name: string, handler: any) => commands.set(name, handler),
    publishEvent: (name: string, payload: unknown) => { published.push({ name, payload }); },
    refreshSnapshot: vi.fn(),
    pinEntries: (pin: any) => pins.push(pin),
    observeUserTurns: (observer: any) => turns.push(observer),
    transcript: () => [],
    openSession: () => undefined,
    isCurrentSession: () => true,
  } satisfies PiKitBridge as unknown as PiKitBridge;
  const pi = { on: (name: string, handler: any) => events.set(name, handler), appendEntry: vi.fn() };
  workspacePiExtension(pi as never, bridge);
  return { commands, events, context, published, pins, turns, pi };
}

describe("workspace kit inside an attached Pi runtime", () => {
  it("answers the host's checkpoint list from Pi's own session, without restore", async () => {
    const kit = harness();
    await expect(kit.commands.get("checkpoints")!(kit.context, {})).resolves.toEqual({
      checkpoints: [expect.objectContaining({ id: "turn-1" })],
      restoreSupported: false,
    });
  });

  it("pins the entries its checkpoint cards anchor to", () => {
    const kit = harness();
    expect(kit.pins.flatMap((pin) => [...pin(kit.context)])).toEqual(["assistant-entry"]);
  });

  it("reports a turn Pi refused as a failed capture", () => {
    const kit = harness();
    kit.turns[0].failed("turn-2", kit.context);
    expect(kit.published).toEqual([{
      name: CHECKPOINT_EVENT,
      payload: { type: "turn-checkpoint-error", sessionId: "session", turnId: "turn-2", message: "Turn checkpoint capture failed." },
    }]);
  });

  it("rejects a historical query for a checkpoint the session no longer holds", async () => {
    const kit = harness();
    await expect(kit.commands.get("turn-files")!(kit.context, { checkpointId: "gone" })).rejects.toThrow(/no longer available/u);
    await expect(kit.commands.get("turn-file-diff")!(kit.context, { checkpointId: "gone", path: "src/app.ts" }))
      .resolves.toMatchObject({ note: expect.stringContaining("no longer available") });
  });
});
