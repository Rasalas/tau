// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useTailScroll } from "./App";

function Fixture({ version, session = "one", preservePosition = false }: { version: number; session?: string; preservePosition?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTailScroll(ref, [version], session, preservePosition);
  return <div
    data-testid="transcript"
    ref={(node) => {
      ref.current = node;
      if (!node || Object.prototype.hasOwnProperty.call(node, "scrollHeight")) return;
      Object.defineProperties(node, {
        scrollHeight: { configurable: true, get: () => 1_000 },
        clientHeight: { configurable: true, get: () => 200 },
        scrollTop: { configurable: true, writable: true, value: 0 },
      });
    }}
  ><div className="transcript-inner" /></div>;
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

  it("preserves the viewport while an older page is inserted", async () => {
    const view = render(<Fixture version={1} />);
    const transcript = view.getByTestId("transcript");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    act(() => {
      transcript.scrollTop = 120;
      transcript.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<Fixture version={2} preservePosition />);
    view.rerender(<Fixture version={3} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript.scrollTop).toBe(120);
  });
});
