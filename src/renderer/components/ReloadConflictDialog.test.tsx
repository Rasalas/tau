// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReloadConflictDialog } from "./ReloadConflictDialog";
import { useEscapeLayer } from "./ui/escape-layers";

afterEach(cleanup);

function setup(runningThreads = 2) {
  const onCancel = vi.fn();
  const onWait = vi.fn();
  const onAbort = vi.fn();
  render(<ReloadConflictDialog runningThreads={runningThreads} onCancel={onCancel} onWait={onWait} onAbort={onAbort} />);
  return { onCancel, onWait, onAbort };
}

describe("ReloadConflictDialog", () => {
  it("offers waiting without stopping work", () => {
    const { onWait, onAbort } = setup();
    fireEvent.click(screen.getByRole("button", { name: /wait, then reload/i }));
    expect(onWait).toHaveBeenCalledOnce();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("offers explicitly stopping every run", () => {
    const { onAbort } = setup(1);
    expect(screen.getByRole("heading", { name: "1 thread is still running" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /stop runs and reload/i }));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("cancels with Escape", () => {
    const { onCancel } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("takes focus on waiting and leaves Escape to a layer opened over it", () => {
    const onCancel = vi.fn();
    function Over() {
      const [open, setOpen] = useState(true);
      useEscapeLayer(() => setOpen(false), open);
      return open ? <p>Menu over the dialog</p> : null;
    }
    const view = (over: boolean) => <><ReloadConflictDialog runningThreads={2} onCancel={onCancel} onWait={() => {}} onAbort={() => {}} />{over ? <Over /> : null}</>;
    const { rerender } = render(view(false));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /wait, then reload/i }));
    rerender(view(true));
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByText("Menu over the dialog")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
