// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, setHostClient, WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { registerCheckpoints } from "./checkpoints.js";
import { CHECKPOINT_EVENT } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

const EXTENSION_ID = "test.checkpoints";

function checkpoint(id: string, paths: string[], extra: Partial<UiTurnCheckpoint> = {}): UiTurnCheckpoint {
  return {
    id, turnId: id, sessionId: "s1", anchorMessageId: `m-${id}`, beforeSnapshotId: "before", afterSnapshotId: "after",
    startedAt: 1, endedAt: Number(id.replace(/\D/gu, "")) || 1,
    files: paths.map((path) => ({ path, name: path, directory: "", status: "modified" as const, added: 1, removed: 0 })),
    fileCount: paths.length, added: paths.length, removed: 0,
    ...extra,
  };
}

describe("checkpoint rows", () => {
  it.each(["desktop", "compact"] as const)("pins the latest turn and leaves earlier turns in the transcript on %s", async (profile) => {
    setHostClient(createFakeHostClient());
    const host = {
      checkpoints: vi.fn(async () => ({ checkpoints: [], restoreSupported: true })),
      canRestoreCheckpoint: vi.fn(async (_sessionId: string, _id: string) => true),
    };
    const { registry } = createKitHarness(undefined, profile);
    const kitState = { changes: { files: [], added: 0, removed: 0 }, draftPending: false, turnSettled: false };
    const workspaceStore = {
      host, recordTurnStat: vi.fn(), subscribe: () => () => undefined, getSnapshot: () => kitState,
      turnChanges: () => ({ files: [], added: 0, removed: 0 }),
    } as unknown as WorkspaceStore;
    registry.activate({ id: EXTENSION_ID, name: "Checkpoints", activate: (context) => registerCheckpoints(context, workspaceStore) });
    const { Component } = registry.getRegions("composer-controls")[0]!;
    const snapshot = { sessionId: "s1", isStreaming: false } as HostSnapshot;
    const actions = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;
    render(
      <WorkbenchContext.Provider value={{ snapshot, tools: [], events: [], registry, openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined } as never}>
        <Component snapshot={snapshot} actions={actions} />
      </WorkbenchContext.Provider>,
    );
    const announce = (entry: UiTurnCheckpoint) => act(() => {
      registry.dispatchExtensionEvent({ type: "extension-event", extensionId: EXTENSION_ID, name: CHECKPOINT_EVENT, payload: { type: "turn-checkpoint", checkpoint: entry } });
    });

    announce(checkpoint("t1", ["src/a.ts"]));
    announce(checkpoint("t2", []));
    announce(checkpoint("t3", [], { completeness: "partial" }));

    await waitFor(() => expect(host.checkpoints).toHaveBeenCalled());
    expect(registry.getTranscriptRows("s1").map((row) => row.id)).toEqual(["checkpoints:t1"]);
    // The partial capture is the latest turn: it sits over the composer, never restorable. On a phone
    // Review Kit draws that pill, so this kit adds no second one.
    expect(screen.queryAllByRole("button", { name: /^Turn changes: 0\+ files/u })).toHaveLength(profile === "desktop" ? 1 : 0);
    // Only turns with a pill are asked about; the hidden turn is still counted as a later turn by a rewind.
    await waitFor(() => expect(host.canRestoreCheckpoint.mock.calls.map(([, id]) => id)).toEqual(["t1"]));
    await waitFor(() => {
      const row = render(<>{registry.getTranscriptRows("s1")[0]!.content}</>);
      try {
        fireEvent.click(within(row.container).getByRole("button", { name: /^Turn changes: 1 file/u }));
        // The detail loads lazily; a later attempt draws it at once.
        expect(screen.getByRole("button", { name: "Rewind" })).toBeTruthy();
      } finally { row.unmount(); }
    });
  });
});

describe("a skipped checkpoint", () => {
  it("is announced with the store's notice, and not at all for a thread the store answers nothing for", async () => {
    setHostClient(createFakeHostClient());
    const host = { checkpoints: vi.fn(async () => ({ checkpoints: [], restoreSupported: false })), canRestoreCheckpoint: vi.fn(async () => false) };
    const { registry } = createKitHarness();
    const kitState = { changes: { files: [], added: 0, removed: 0 }, draftPending: false, turnSettled: false };
    const workspaceStore = {
      host, recordTurnStat: vi.fn(), subscribe: () => () => undefined, getSnapshot: () => kitState,
      turnChanges: () => ({ files: [], added: 0, removed: 0 }),
      skippedCheckpointNotice: (sessionId: string) => sessionId === "stayed" ? "Not recorded; start the next thread in its own worktree." : undefined,
    } as unknown as WorkspaceStore;
    registry.activate({ id: EXTENSION_ID, name: "Checkpoints", activate: (context) => registerCheckpoints(context, workspaceStore) });
    const { Component } = registry.getRegions("composer-controls")[0]!;
    const snapshot = { sessionId: "stayed", isStreaming: false } as HostSnapshot;
    const notify = vi.fn();
    const actions = new Proxy({}, { get: (_target, key) => key === "notify" ? notify : () => undefined }) as WorkbenchActions;
    render(
      <WorkbenchContext.Provider value={{ snapshot, tools: [], events: [], registry, openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined } as never}>
        <Component snapshot={snapshot} actions={actions} />
      </WorkbenchContext.Provider>,
    );
    const skip = (sessionId: string) => act(() => {
      registry.dispatchExtensionEvent({ type: "extension-event", extensionId: EXTENSION_ID, name: CHECKPOINT_EVENT, payload: { type: "turn-checkpoint-status", sessionId, turnId: "t1", status: "skipped" } });
    });

    skip("fell-back");
    skip("stayed");
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Not recorded; start the next thread in its own worktree."));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
