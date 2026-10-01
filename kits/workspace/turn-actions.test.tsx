// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, TranscriptTurn, UiMessage, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, setHostClient, WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { registerCheckpoints } from "./checkpoints.js";
import { CHECKPOINT_EVENT } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

const EXTENSION_ID = "test.turn-actions";

const prompt: UiMessage = { id: "u2", sourceEntryId: "e-u2", role: "user", text: "Add a regression test", timestamp: 1 };
const answer: UiMessage = { id: "a2", sourceEntryId: "e-a2", role: "assistant", text: "Added it.", timestamp: 2 };
const pending: UiMessage = { id: "local", role: "assistant", text: "", timestamp: 3 };
const turn: TranscriptTurn = { number: 3, messages: [prompt, answer, pending], last: false };

const checkpoint: UiTurnCheckpoint = {
  id: "c3", turnId: "c3", sessionId: "s1", anchorMessageId: "e-a2", beforeSnapshotId: "before", afterSnapshotId: "after",
  startedAt: 1, endedAt: 2, files: [{ path: "a.ts", name: "a.ts", directory: "", status: "modified", added: 1, removed: 0 }],
  fileCount: 1, added: 1, removed: 0,
};

function setUp({ streaming = false, forkFrom = vi.fn(async () => undefined) } = {}) {
  setHostClient(createFakeHostClient());
  const host = {
    checkpoints: vi.fn(async () => ({ checkpoints: [checkpoint], restoreSupported: true })),
    canRestoreCheckpoint: vi.fn(async () => true),
    getRestorePreview: vi.fn(async () => ({ files: [], added: 0, removed: 0 })),
  };
  const kit = { changes: { files: [], added: 0, removed: 0 }, draftPending: false, turnSettled: true, workspace: { branch: "fix/pairing-flake" } };
  const workspaceStore = {
    host, recordTurnStat: vi.fn(), subscribe: () => () => undefined, getSnapshot: () => kit,
    turnChanges: () => ({ files: [], added: 0, removed: 0 }),
  } as unknown as WorkspaceStore;
  const { registry } = createKitHarness(undefined, "desktop");
  registry.activate({ id: EXTENSION_ID, name: "Checkpoints", activate: (context) => registerCheckpoints(context, workspaceStore) });
  const Controller = registry.getRegions("composer-controls")[0]!.Component;
  const Actions = registry.getRegions("turn-divider")[0]!.Component;
  const snapshot = { sessionId: "s1", isStreaming: streaming } as HostSnapshot;
  const actions = new Proxy({ forkFrom }, { get: (target, key) => key === "forkFrom" ? target.forkFrom : () => undefined }) as unknown as WorkbenchActions;
  const view = (drawn: TranscriptTurn) => (
    <WorkbenchContext.Provider value={{ snapshot, tools: [], events: [], registry, openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined } as never}>
      <Controller snapshot={snapshot} actions={actions} />
      <div className="turn-divider"><Actions snapshot={snapshot} actions={actions} turn={drawn} /></div>
    </WorkbenchContext.Provider>
  );
  return { host, forkFrom, registry, view };
}

describe("the actions on a turn's divider (design 2d)", () => {
  it("asks before it forks through the turn's last saved message, and names the branch the fork will share", async () => {
    const { forkFrom, view } = setUp();
    render(view(turn));

    fireEvent.click(screen.getByRole("button", { name: /Fork here/u }));
    const dialog = await screen.findByRole("dialog", { name: "Fork from turn 3?" });
    expect(dialog.textContent).toContain("turns 1–3");
    expect((screen.getByDisplayValue("fix/pairing-flake") as HTMLInputElement).readOnly).toBe(true);
    expect(forkFrom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(forkFrom).toHaveBeenCalledWith(answer);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Fork from turn 3?" })).toBeNull());
  });

  it("closes the question on Cancel without forking", async () => {
    const { forkFrom, view } = setUp();
    render(view(turn));
    fireEvent.click(screen.getByRole("button", { name: /Fork here/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(forkFrom).not.toHaveBeenCalled();
  });

  it("offers Restore files once the turn's checkpoint is verified, and opens the rewind dialog", async () => {
    const { host, registry, view } = setUp();
    render(view(turn));
    act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: EXTENSION_ID, name: CHECKPOINT_EVENT, payload: { type: "turn-checkpoint", checkpoint } }));

    fireEvent.click(await screen.findByRole("button", { name: /Restore files/u }));
    await waitFor(() => expect(host.getRestorePreview).toHaveBeenCalledWith("s1", "c3"));
    expect(await screen.findByText("Rewind to this checkpoint?")).toBeTruthy();
  });

  it("offers nothing on the turn that still runs", () => {
    const { view } = setUp({ streaming: true });
    const drawn = render(view({ ...turn, last: true }));
    expect(drawn.container.querySelector(".turn-actions")).toBeNull();
  });
});
