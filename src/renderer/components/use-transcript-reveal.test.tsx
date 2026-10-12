// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { requestReveal } from "./transcript-reveal";
import { useTranscriptReveal } from "./use-transcript-reveal";

afterEach(cleanup);

const message = (id: string): UiMessage => ({ id, role: "assistant", text: id, timestamp: 1 });

function mount(initial: UiMessage[], jumpToMessage: (id: string) => void, loadThrough?: (id: string) => Promise<boolean>, sessionId = "t1") {
  let node!: HTMLDivElement;
  function Host({ messages }: { messages: UiMessage[] }) {
    const ref = useRef<HTMLDivElement>(null);
    useTranscriptReveal({ scrollRef: ref, sessionId, messages, jumpToMessage, loadThrough });
    return <div ref={(element) => { ref.current = element; if (element) node = element; }}>
      {messages.map((entry) => <div key={entry.id} data-message-id={entry.id} />)}
    </div>;
  }
  const view = render(<Host messages={initial} />);
  return { node: () => node, update: (messages: UiMessage[]) => view.rerender(<Host messages={messages} />) };
}

describe("revealing a message", () => {
  it("scrolls to a message that is loaded and marks its row", async () => {
    const jump = vi.fn();
    const { node } = mount([message("a"), message("b")], jump);
    expect(await act(() => requestReveal(node(), "b"))).toBe(true);
    expect(jump).toHaveBeenCalledWith("b");
    expect(node().querySelector('[data-message-id="b"]')?.classList.contains("reveal-flash")).toBe(true);
  });

  it("loads older turns for a message that is not there, then scrolls once its row exists", async () => {
    const jump = vi.fn();
    let finish!: (found: boolean) => void;
    const load = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { node, update } = mount([message("b")], jump, load);
    let result: Promise<boolean>;
    act(() => { result = requestReveal(node(), "a"); });
    expect(load).toHaveBeenCalledWith("a");
    expect(jump).not.toHaveBeenCalled();
    await act(async () => { finish(true); });
    expect(await result!).toBe(true);
    // The page has been applied to the store but not yet to the rows.
    expect(jump).not.toHaveBeenCalled();
    update([message("a"), message("b")]);
    expect(jump).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("answers false when the thread does not reach back to the message, and when nothing listens", async () => {
    const jump = vi.fn();
    const { node } = mount([message("b")], jump, async () => false);
    expect(await act(() => requestReveal(node(), "gone"))).toBe(false);
    expect(jump).not.toHaveBeenCalled();
    expect(await requestReveal(document.createElement("div"), "b")).toBe(false);
    expect(await requestReveal(null, "b")).toBe(false);
  });
});
