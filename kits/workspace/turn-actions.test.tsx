// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, TranscriptTurn, UiMessage, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, setHostClient, WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { registerCheckpoints } from "./checkpoints.js";
import { CHECKPOINT_EVENT } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";
import { nextForkBranch } from "./turn-actions.js";
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

const created = { workspaceId: "ws-fork", displayPath: "/wt/fix-pairing-flake-2", path: "/wt/fix-pairing-flake-2", copied: true };

function setUp({ streaming = false, repo = true, restorable = true, forkFrom = vi.fn(async () => true), checkpoints = [checkpoint] } = {}) {
  setHostClient(createFakeHostClient());
  const host = {
    checkpoints: vi.fn(async () => ({ checkpoints, restoreSupported: true })),
    canRestoreCheckpoint: vi.fn(async () => restorable),
    getRestorePreview: vi.fn(async () => ({ files: [], added: 0, removed: 0 })),
    forkWorktree: vi.fn(async () => created),
    removeWorktree: vi.fn(async () => undefined),
  };
  const refs = [{ name: "fix/pairing-flake", isCurrent: true }, { name: "main", isCurrent: false }];
  const kit = { changes: { files: [], added: 0, removed: 0 }, draftPending: false, turnSettled: true, workspace: { branch: "fix/pairing-flake", isRepo: repo, refs } };
  const workspaceStore = {
    host, recordTurnStat: vi.fn(), subscribe: () => () => undefined, getSnapshot: () => kit, workspace: () => "ws-source",
    turnChanges: () => ({ files: [], added: 0, removed: 0 }),
  } as unknown as WorkspaceStore;
  const { registry } = createKitHarness(undefined, "desktop");
  registry.activate({ id: EXTENSION_ID, name: "Checkpoints", activate: (context) => registerCheckpoints(context, workspaceStore) });
  const controls = registry.getRegions("composer-controls");
  const Controller = controls.find((region) => region.id === "workspace.checkpoints")!.Component;
  const Asker = controls.find((region) => region.id === "workspace.fork")!.Component;
  const Actions = registry.getRegions("turn-divider")[0]!.Component;
  const snapshot = { sessionId: "s1", workspaceId: "ws-source", isStreaming: streaming, messages: [prompt, answer] } as unknown as HostSnapshot;
  const notify = vi.fn();
  const actions = new Proxy({ forkFrom, notify }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as WorkbenchActions;
  const view = (drawn: TranscriptTurn) => (
    <WorkbenchContext.Provider value={{ snapshot, tools: [], events: [], registry, openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined } as never}>
      <Controller snapshot={snapshot} actions={actions} />
      <Asker snapshot={snapshot} actions={actions} />
      <div className="turn-divider"><Actions snapshot={snapshot} actions={actions} turn={drawn} /></div>
    </WorkbenchContext.Provider>
  );
  return { host, forkFrom, notify, registry, view };
}

describe("forking from a turn (design 2d)", () => {
  it("names the next free branch after the thread's", () => {
    expect(nextForkBranch("fix/pairing-flake", ["fix/pairing-flake"])).toBe("fix/pairing-flake-2");
    expect(nextForkBranch("fix/pairing-flake", ["fix/pairing-flake-2"])).toBe("fix/pairing-flake-3");
    expect(nextForkBranch("fix/pairing-flake-2", ["fix/pairing-flake-2"])).toBe("fix/pairing-flake-3");
    expect(nextForkBranch(undefined, [])).toBe("tau/fork-2");
  });

  it("asks, then forks through the turn's last saved message into a worktree made from its checkpoint", async () => {
    const { host, forkFrom, view } = setUp();
    render(view(turn));

    fireEvent.click(screen.getByRole("button", { name: /Fork here/u }));
    const dialog = await screen.findByRole("dialog", { name: "Fork from turn 3?" });
    await waitFor(() => expect(dialog.textContent).toContain("turns 1–3 and a copy of the worktree at that point"));
    const branch = screen.getByRole("textbox", { name: "Branch" }) as HTMLInputElement;
    expect(branch.value).toBe("fix/pairing-flake-2");
    fireEvent.change(branch, { target: { value: "fix/pairing-flake-alt" } });
    expect(forkFrom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(forkFrom).toHaveBeenCalledWith({ sourceEntryId: "e-a2" }, { workspace: "ws-fork" }));
    expect(host.forkWorktree).toHaveBeenCalledWith({ branch: "fix/pairing-flake-alt", sessionId: "s1", checkpointId: "c3" }, "ws-source");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Fork from turn 3?" })).toBeNull());
    expect(host.removeWorktree).not.toHaveBeenCalled();
  });

  it("says so when the turn has no verified checkpoint, and starts the worktree from HEAD", async () => {
    const { host, forkFrom, view } = setUp({ restorable: false });
    render(view(turn));
    fireEvent.click(screen.getByRole("button", { name: /Fork here/u }));
    const dialog = await screen.findByRole("dialog", { name: "Fork from turn 3?" });
    await waitFor(() => expect(dialog.textContent).toContain("Turn 3 has no checkpoint, so the worktree starts from fix/pairing-flake's last commit"));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(forkFrom).toHaveBeenCalled());
    expect(host.forkWorktree).toHaveBeenCalledWith({ branch: "fix/pairing-flake-2" }, "ws-source");
  });

  it("removes the worktree again when the fork itself fails", async () => {
    const { host, view } = setUp({ forkFrom: vi.fn(async () => false) });
    render(view(turn));
    fireEvent.click(screen.getByRole("button", { name: /Fork here/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Fork" }));
    await waitFor(() => expect(host.removeWorktree).toHaveBeenCalledWith("/wt/fix-pairing-flake-2", "fix/pairing-flake-2", "ws-source"));
    expect(screen.getByRole("dialog", { name: "Fork from turn 3?" })).toBeTruthy();
  });

  it("forks in the folder itself where there is no Git repository", async () => {
    const { host, forkFrom, view } = setUp({ repo: false });
    render(view(turn));
    fireEvent.click(screen.getByRole("button", { name: /Fork here/u }));
    await screen.findByRole("dialog", { name: "Fork from turn 3?" });
    expect(screen.queryByRole("textbox", { name: "Branch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(forkFrom).toHaveBeenCalledWith({ sourceEntryId: "e-a2" }, {}));
    expect(host.forkWorktree).not.toHaveBeenCalled();
  });

  it("asks the same question for a fork core hands over (`f`, the tree), and for Duplicate with the checkout as it is", async () => {
    const { host, forkFrom, registry, view } = setUp();
    render(view(turn));
    act(() => registry.getForkPrompt()!.ask({ entryId: "e-a2", turn }));
    await screen.findByRole("dialog", { name: "Fork from turn 3?" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => registry.getForkPrompt()!.ask({}));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate this thread?" });
    expect(dialog.textContent).toContain("the whole conversation and a copy of the worktree as it is now");
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(forkFrom).toHaveBeenCalledWith({ sourceEntryId: "e-a2" }, { workspace: "ws-fork" }));
    expect(host.forkWorktree).toHaveBeenCalledWith({ branch: "fix/pairing-flake-2", now: true }, "ws-source");
  });

  it("closes the question on Cancel without forking", async () => {
    const { forkFrom, host, view } = setUp();
    render(view(turn));
    fireEvent.click(screen.getByRole("button", { name: /Fork here/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(forkFrom).not.toHaveBeenCalled();
    expect(host.forkWorktree).not.toHaveBeenCalled();
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
