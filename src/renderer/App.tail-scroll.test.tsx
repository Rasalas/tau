// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useTailScroll } from "./App";

function Fixture({
  version,
  session = "one",
  anchorId,
  visible = true,
  clientHeight = 200,
}: {
  version: number;
  session?: string;
  anchorId?: string;
  visible?: boolean;
  clientHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const clientHeightRef = useRef(clientHeight);
  clientHeightRef.current = clientHeight;
  const scroll = useTailScroll(ref, [version], session, anchorId, visible);
  return visible ? <div
      data-testid="transcript"
      style={{ paddingTop: 20 }}
      ref={(node) => {
        ref.current = node;
        if (!node || Object.prototype.hasOwnProperty.call(node, "scrollHeight")) return;
        Object.defineProperties(node, {
          scrollHeight: { configurable: true, get: () => 1_000 },
          clientHeight: { configurable: true, get: () => clientHeightRef.current },
          scrollTop: { configurable: true, writable: true, value: 0 },
        });
      }}
    >
      {anchorId ? <div data-message-id={anchorId} data-transcript-offset={600} /> : null}
      <div className="transcript-inner" />
      {scroll.canJumpToLatest ? <button type="button" onClick={scroll.jumpToLatest}>Jump to latest</button> : null}
    </div>
    : null;
}

afterEach(cleanup);

describe("useTailScroll", () => {
  it("starts at the newest chat position", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");

    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
  });

  it("does not pull the user down after they scroll upward", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    act(() => {
      transcript.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      transcript.scrollTop = 300;
      transcript.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<Fixture version={2} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript.scrollTop).toBe(300);
  });

  it("does not mistake layout-driven scroll events for user intent", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    act(() => {
      transcript.scrollTop = 500;
      transcript.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<Fixture version={2} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
  });

  it("starts a newly selected session at its tail", async () => {
    const view = render(<Fixture version={1} session="one" />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
    act(() => {
      transcript.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      transcript.scrollTop = 300;
      transcript.dispatchEvent(new Event("scroll"));
    });

    view.rerender(<Fixture version={2} session="two" />);
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
  });

  it("anchors a newly sent prompt at the usable top when the thread has room", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    view.rerender(<Fixture version={2} anchorId="new-prompt" />);
    await waitFor(() => expect(transcript.scrollTop).toBe(580));
  });

  it("does not create blank scroll space for a short thread", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    view.rerender(<Fixture version={2} anchorId="new-prompt" clientHeight={600} />);
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
  });

  it("attaches interaction tracking when the transcript mounts after the start screen", async () => {
    const view = render(<Fixture version={1} visible={false} />);
    view.rerender(<Fixture version={2} anchorId="new-prompt" />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(580));

    fireEvent.wheel(transcript, { deltaY: -100 });
    expect(await view.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("shows a latest action after keyboard history navigation", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    act(() => {
      transcript.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    });

    expect(await view.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("stops following when a touch gesture moves toward older content", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    fireEvent.touchStart(transcript, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(transcript, { touches: [{ clientY: 140 }] });

    expect(await view.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("returns to the latest tail through the visible action", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    fireEvent.wheel(transcript, { deltaY: -100 });
    const jump = await view.findByRole("button", { name: "Jump to latest" });
    fireEvent.click(jump);

    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
    expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });
});
