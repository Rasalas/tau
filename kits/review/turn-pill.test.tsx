// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, HostSnapshot, RegionProps, WorkbenchActions } from "tau";
import { createKitHarness, WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { reviewExtension } from "./desktop.js";
import { CompactReviewStore } from "./compact-store.js";
import { REVIEW_COMPACT_PANEL, WORKSPACE_CHECKPOINT_EVENT, type ReviewTurn } from "./protocol.js";
import { createCompactTurnPill, latestChangedTurn } from "./turn-pill.js";

afterEach(cleanup);

const FILE = { path: "src/a.ts", name: "a.ts", directory: "src", status: "modified" as const, added: 2, removed: 1 };
const turn = (id: string, endedAt: number, extra: Partial<ReviewTurn> = {}): ReviewTurn =>
  ({ id, sessionId: "s1", startedAt: endedAt - 1, endedAt, files: [FILE], fileCount: 1, added: 2, removed: 1, ...extra });

function setup(options: { turns: ReviewTurn[]; streaming?: boolean }) {
  let turns = options.turns;
  let emit: ((payload: unknown) => void) | undefined;
  const invoke = vi.fn(async () => ({ checkpoints: turns, restoreSupported: false }));
  const workspace: HostExtensionClient = {
    invoke,
    onEvent: (name, listener) => { if (name === WORKSPACE_CHECKPOINT_EVENT) emit = listener; return () => { emit = undefined; }; },
  };
  const store = new CompactReviewStore();
  store.update({ sessionId: "s1", source: { kind: "worktree" }, page: "diff", path: "b.ts" });
  const Pill = createCompactTurnPill({ workspace, store });
  const actions = { activeThread: () => ({ sessionId: "s1", cwd: "/p" }), openPanel: vi.fn() } as unknown as WorkbenchActions;
  const snapshot = { sessionId: "s1", isStreaming: options.streaming ?? false } as HostSnapshot;
  render(
    <WorkbenchContext.Provider value={{ snapshot, tools: [], events: [] } as never}>
      <Pill {...({ snapshot, actions } as RegionProps)} />
    </WorkbenchContext.Provider>,
  );
  return {
    store, actions, invoke,
    record(next: ReviewTurn[]) { turns = next; act(() => emit?.({ type: "turn-checkpoint", sessionId: "s1" })); },
  };
}

describe("the phone's turn pill", () => {
  it("names the latest turn that changed something", () => {
    expect(latestChangedTurn([turn("t2", 2), turn("t1", 1), turn("t3", 3, { files: [], fileCount: 0 })])?.id).toBe("t2");
    expect(latestChangedTurn([turn("t1", 1), turn("t2", 2, { files: [], fileCount: 0, completeness: "partial" })])?.id).toBe("t2");
    expect(latestChangedTurn([])).toBeUndefined();
  });

  it("opens the Review sheet on that turn's files", async () => {
    const { store, actions } = setup({ turns: [turn("t1", 1), turn("t2", 2, { files: [FILE, { ...FILE, path: "b.ts" }], fileCount: 2, added: 5, removed: 0 })] });

    const pill = await screen.findByRole("button", { name: "Turn changes: 2 files, 5 lines added, 0 removed" });
    expect(pill.textContent).toBe("2 files+5−0");
    fireEvent.click(pill);

    expect(store.getSnapshot()).toMatchObject({ sessionId: "s1", source: { kind: "turn", id: "t2" }, page: "files", path: undefined });
    expect(actions.openPanel).toHaveBeenCalledWith(REVIEW_COMPACT_PANEL);
  });

  it("follows a turn that has just been recorded", async () => {
    const { record } = setup({ turns: [] });
    await act(async () => undefined);
    expect(screen.queryByRole("button")).toBeNull();

    record([turn("t1", 1)]);
    expect(await screen.findByRole("button", { name: /^Turn changes: 1 file,/u })).toBeTruthy();
  });

  it("steps aside while a turn runs", async () => {
    const { invoke } = setup({ turns: [turn("t1", 1)], streaming: true });
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sits in the centred row over the composer, beside Jump to latest", () => {
    const { registry } = createKitHarness(undefined, "compact");
    registry.activate(reviewExtension);
    expect(registry.getRegions("composer-controls").map((entry) => entry.id)).toContain("review.turn-pill");
    expect(registry.getRegions("composer-above").map((entry) => entry.id)).not.toContain("review.turn-pill");
    registry.deactivate(reviewExtension.id);
  });
});
