// @vitest-environment jsdom
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, setHostClient, WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { checkpointHasCard, registerCheckpoints } from "./checkpoints.js";
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

describe("checkpointHasCard", () => {
  it("draws a card only for a turn that changed files, or whose capture may have missed some", () => {
    expect(checkpointHasCard(checkpoint("t1", []))).toBe(false);
    expect(checkpointHasCard(checkpoint("t2", ["a.ts"]))).toBe(true);
    expect(checkpointHasCard(checkpoint("t3", [], { completeness: "partial" }))).toBe(true);
    // A summary without its file list still counts its files.
    expect(checkpointHasCard({ ...checkpoint("t4", []), fileCount: 3 })).toBe(true);
  });
});

describe("checkpoint rows", () => {
  it("leaves no row for a turn without file changes, and the others still rewind", async () => {
    setHostClient(createFakeHostClient());
    const host = {
      checkpoints: vi.fn(async () => ({ checkpoints: [], restoreSupported: true })),
      canRestoreCheckpoint: vi.fn(async (_sessionId: string, _id: string) => true),
    };
    const { registry } = createKitHarness();
    registry.activate({ id: EXTENSION_ID, name: "Checkpoints", activate: (context) => registerCheckpoints(context, { host } as unknown as WorkspaceStore) });
    const { Component } = registry.getRegions("transcript-header")[0]!;
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
    expect(registry.getTranscriptRows("s1").map((row) => row.id)).toEqual(["checkpoints:t1", "checkpoints:t3"]);
    // Only drawn cards are asked about; the hidden turn is still counted as a later turn by a rewind.
    await waitFor(() => expect(host.canRestoreCheckpoint.mock.calls.map(([, id]) => id)).toEqual(["t1"]));
    await waitFor(() => {
      const card = render(<>{registry.getTranscriptRows("s1")[0]!.content}</>);
      try { expect(within(card.container).getByText("Rewind")).toBeTruthy(); } finally { card.unmount(); }
    });
  });
});
