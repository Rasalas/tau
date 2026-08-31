// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../shared/contracts";

vi.mock("./components/Message", () => ({
  Message: ({ message }: { message: UiMessage }) => <div>{message.text}</div>,
}));
vi.mock("./components/VirtualTranscript", () => ({
  VirtualTranscript: ({ messages }: { messages: UiMessage[] }) => <div
    className="virtual-transcript"
    style={{ height: `${messages.length * 180}px`, position: "relative" }}
  >
    {messages.map((message, index) => <div
      key={message.id}
      className="virtual-transcript-row"
      data-index={index}
      data-message-id={message.id}
    >
      <div>{message.text}</div>
    </div>)}
  </div>,
}));

import { TranscriptViewport } from "./components/TranscriptViewport";

const oldMessage: UiMessage = {
  id: "old",
  role: "assistant",
  text: "Older answer",
  timestamp: 1_000,
};
const originalPrompt: UiMessage = {
  id: "prompt-1",
  role: "user",
  text: "The original prompt",
  timestamp: 2_000,
};

function Fixture({
  messages,
  latestUserMessage,
  sessionId = "one",
  initialTurnIsNew = false,
  scrollHeight = 1_000,
  clientHeight = 200,
}: {
  messages: UiMessage[];
  latestUserMessage?: UiMessage;
  sessionId?: string;
  initialTurnIsNew?: boolean;
  scrollHeight?: number;
  clientHeight?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollHeightRef = useRef(scrollHeight);
  const clientHeightRef = useRef(clientHeight);
  scrollHeightRef.current = scrollHeight;
  clientHeightRef.current = clientHeight;
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || Object.prototype.hasOwnProperty.call(node, "scrollHeight")) return;
    Object.defineProperties(node, {
      scrollHeight: { configurable: true, get: () => scrollHeightRef.current },
      clientHeight: { configurable: true, get: () => clientHeightRef.current },
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollTo: {
        configurable: true,
        value: ({ top }: { top: number }) => { node.scrollTop = top; },
      },
    });
  }, []);

  return <TranscriptViewport
    messages={messages}
    scrollRef={scrollRef}
    sessionId={sessionId}
    latestUserMessage={latestUserMessage ?? [...messages].reverse().find((message) => message.role === "user")}
    initialTurnIsNew={initialTurnIsNew}
    isStreaming={false}
  />;
}

afterEach(cleanup);

describe("TranscriptViewport navigation", () => {
  it("follows the newest content without putting scroll state in App", async () => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const transcript = view.getByRole("log");

    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
  });

  it("pins a real newly sent prompt immediately, with no empty history spacer", async () => {
    const view = render(<Fixture messages={[]} />);
    view.rerender(<Fixture
      messages={[{ id: "local-1", role: "user", text: "Build the first screen", timestamp: 3_000 }]}
      initialTurnIsNew
      scrollHeight={0}
      clientHeight={600}
    />);

    const current = await waitFor(() => view.container.querySelector(".transcript-current-turn"));
    expect(current).toBeTruthy();
    expect(within(current as HTMLElement).getByText("Build the first screen")).toBeTruthy();
    const transcript = view.getByRole("log");
    expect(transcript.scrollTop).toBe(0);
    expect(transcript.querySelector(".virtual-transcript")?.getAttribute("style")).toContain("height: 0px");
  });

  it("keeps the pinned prompt in place while an answer grows below it", async () => {
    const prompt: UiMessage = { id: "local-2", role: "user", text: "Explain this", timestamp: 4_000 };
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    view.rerender(<Fixture messages={[oldMessage, originalPrompt, prompt]} />);
    const current = await waitFor(() => view.container.querySelector(".transcript-current-turn"));
    const promptRow = current?.querySelector('[data-message-id="local-2"]');
    expect(promptRow).toBeTruthy();

    const answer: UiMessage = { id: "answer-2", role: "assistant", text: "Here is the answer", timestamp: 5_000 };
    view.rerender(<Fixture messages={[oldMessage, originalPrompt, prompt, answer]} />);

    await waitFor(() => expect(current?.textContent).toContain("Here is the answer"));
    expect(view.container.querySelector(".transcript-current-turn [data-message-id=\"local-2\"]")).toBe(promptRow);
  });

  it("does not reactivate following when an optimistic id becomes authoritative after history navigation", async () => {
    const optimistic: UiMessage = { id: "local-3", role: "user", text: "Continue", timestamp: 6_000 };
    const authoritative: UiMessage = { id: "saved-3", role: "user", text: "Continue", timestamp: 6_000 };
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    view.rerender(<Fixture messages={[oldMessage, originalPrompt, optimistic]} />);
    await waitFor(() => expect(view.container.querySelector(".transcript-current-turn")).toBeTruthy());

    const transcript = view.getByRole("log");
    fireEvent.wheel(transcript, { deltaY: -100 });
    act(() => {
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
    });
    await view.findByRole("button", { name: "Jump to latest" });

    view.rerender(<Fixture messages={[oldMessage, originalPrompt, authoritative]} latestUserMessage={authoritative} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Jump to latest" })).toBeTruthy());
    expect(view.container.querySelector(".transcript-current-turn")).toBeNull();
  });

  it("stops following on upward mouse-wheel navigation and keeps the action in an overlay", async () => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    fireEvent.wheel(transcript, { deltaY: -100 });
    act(() => {
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
    });

    const jump = await view.findByRole("button", { name: "Jump to latest" });
    expect(jump.closest(".transcript-overlay")).toBeTruthy();
    expect(jump.closest(".transcript")).toBeNull();
  });

  it("does not treat a layout scroll event as a history gesture", async () => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    act(() => {
      transcript.scrollTop = 500;
      fireEvent.scroll(transcript);
    });
    view.rerender(<Fixture messages={[oldMessage, originalPrompt]} />);

    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
    expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it.each(["PageUp", "Home"])("stops following on %s", async (key) => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    fireEvent.keyDown(transcript, { key });

    expect(await view.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("stops following when touch navigation moves toward older content", async () => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    fireEvent.touchStart(transcript, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(transcript, { touches: [{ clientY: 140 }] });

    expect(await view.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("does not let a stale downward wheel intent undo a later upward scroll", async () => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));

    fireEvent.wheel(transcript, { deltaY: 100 });
    fireEvent.wheel(transcript, { deltaY: -100 });
    act(() => {
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
    });

    const jump = await view.findByRole("button", { name: "Jump to latest" });
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(view.getByRole("button", { name: "Jump to latest" })).toBe(jump);
  });

  it("resets navigation for a thread switch and follows the new tail", async () => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} sessionId="one" />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
    fireEvent.wheel(transcript, { deltaY: -100 });
    act(() => {
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
    });
    await view.findByRole("button", { name: "Jump to latest" });

    view.rerender(<Fixture
      messages={[{ id: "new", role: "assistant", text: "New thread", timestamp: 7_000 }]}
      sessionId="two"
    />);
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
    expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("returns to the current turn through the overlay action", async () => {
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_000));
    fireEvent.wheel(transcript, { deltaY: -100 });
    act(() => {
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
    });

    fireEvent.click(await view.findByRole("button", { name: "Jump to latest" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Jump to latest" })).toBeNull());
  });
});
