// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PENDING_ATTACHMENT_MS, usePendingAttachments } from "./use-pending-attachments";

const file = (name: string) => new File(["x"], name, { type: "text/plain" });

function setup(initial: string | undefined) {
  const addFiles = vi.fn(async () => undefined);
  const ref = { current: { addFiles } as never };
  let time = 1_000;
  const view = renderHook(({ session }) => usePendingAttachments(ref, session, () => time), { initialProps: { session: initial } });
  return { addFiles, view, advance: (ms: number) => { time += ms; } };
}

describe("usePendingAttachments", () => {
  it("attaches at once to the thread on screen", () => {
    const { addFiles, view } = setup("a");
    view.result.current([file("one.txt")], { sessionId: "a" });
    expect(addFiles).toHaveBeenCalledWith([expect.objectContaining({ name: "one.txt" })]);
  });

  it("waits for the named thread to come on screen", () => {
    const { addFiles, view } = setup("a");
    view.result.current([file("two.txt")], { sessionId: "b" });
    expect(addFiles).not.toHaveBeenCalled();
    view.rerender({ session: "b" });
    expect(addFiles).toHaveBeenCalledTimes(1);
    view.rerender({ session: "a" });
    view.rerender({ session: "b" });
    expect(addFiles).toHaveBeenCalledTimes(1);
  });

  it("drops files whose thread never came", () => {
    const { addFiles, view, advance } = setup("a");
    view.result.current([file("late.txt")], { sessionId: "b" });
    advance(PENDING_ATTACHMENT_MS + 1);
    view.rerender({ session: "b" });
    expect(addFiles).not.toHaveBeenCalled();
  });
});
