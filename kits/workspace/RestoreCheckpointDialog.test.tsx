// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEscapeLayer } from "tau";
import { RestoreCheckpointDialog, turnFinishedLabel } from "./RestoreCheckpointDialog.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";

afterEach(cleanup);

const checkpoint: UiTurnCheckpoint = {
  id: "c3", turnId: "turn-0123456789abcdef", sessionId: "s1", anchorMessageId: "e-a2", beforeSnapshotId: "before", afterSnapshotId: "after",
  startedAt: Date.now() - 60_000, endedAt: Date.now(), files: [], fileCount: 0, added: 0, removed: 0,
};

function Over() {
  const [open, setOpen] = useState(true);
  useEscapeLayer(() => setOpen(false), open);
  return open ? <p>Menu over the dialog</p> : null;
}

function view({ over = false, onCancel = vi.fn(), onConfirm = vi.fn() } = {}) {
  return <>
    <RestoreCheckpointDialog checkpoint={checkpoint} laterTurns={1} workspaceChanges={{ files: [], added: 0, removed: 0 }} onCancel={onCancel} onConfirm={onConfirm} />
    {over ? <Over /> : null}
  </>;
}

describe("RestoreCheckpointDialog", () => {
  it("names the turn by when it finished, not by its id", async () => {
    render(view());
    const dialog = await screen.findByRole("dialog", { name: "Rewind to this checkpoint?" });
    expect(dialog.textContent).not.toContain("turn-0123456");
    expect(dialog.textContent).toContain(turnFinishedLabel(checkpoint.endedAt));
    expect(turnFinishedLabel(checkpoint.endedAt)).toMatch(/^Turn finished at /u);
    expect(turnFinishedLabel(Date.UTC(2026, 0, 2, 12), Date.UTC(2026, 5, 1, 12))).toMatch(/^Turn finished (?!at )/u);
  });

  it("takes focus and leaves Escape to a layer opened over it", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(view({ onCancel, onConfirm }));
    const keep = await screen.findByRole("button", { name: "Keep changes" });
    expect(document.activeElement).toBe(keep);

    rerender(view({ over: true, onCancel, onConfirm }));
    act(() => { fireEvent.keyDown(keep, { key: "Escape" }); });
    expect(screen.queryByText("Menu over the dialog")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(keep, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps changes with the modifier and Enter only from inside the dialog", async () => {
    const onConfirm = vi.fn();
    render(<>{view({ onConfirm })}<input aria-label="Elsewhere" /></>);
    const keep = await screen.findByRole("button", { name: "Keep changes" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Elsewhere" }), { key: "Enter", ctrlKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(keep, { key: "Enter", ctrlKey: true });
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});
