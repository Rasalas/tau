// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../shared/contracts";
import type { TranscriptTurnStart } from "./components/TranscriptViewport";

vi.mock("./components/Message", () => ({
  Message: ({ message }: { message: UiMessage }) => <div>{message.text}</div>,
}));
vi.mock("./components/VirtualTranscript", () => ({
  VirtualTranscript: ({ messages, activeTurnStartId }: { messages: UiMessage[]; activeTurnStartId?: string }) => {
    const activeIndex = activeTurnStartId ? messages.findIndex((message) => message.id === activeTurnStartId) : -1;
    return <div
      className="virtual-transcript"
      style={{ height: `${messages.length * 180}px`, position: "relative" }}
    >
      {messages.map((message, index) => <div
        key={message.id}
        className={`virtual-transcript-row${activeIndex >= 0 && index >= activeIndex ? " transcript-current-row" : ""}`}
        data-index={index}
        data-message-id={message.id}
      >
        <div>{message.text}</div>
      </div>)}
    </div>;
  },
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
  turnStart,
  sessionId = "one",
  scrollHeight = 1_000,
  clientHeight = 200,
}: {
  messages: UiMessage[];
  turnStart?: TranscriptTurnStart;
  sessionId?: string;
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
    turnStart={turnStart}
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
      turnStart={{ turnId: "turn-1", sessionId: "one", messageId: "local-1", text: "Build the first screen", timestamp: 3_000 }}
      scrollHeight={0}
      clientHeight={600}
    />);

    const current = await waitFor(() => view.container.querySelector(".transcript-current-row"));
    expect(current).toBeTruthy();
    expect(within(current?.parentElement as HTMLElement).getByText("Build the first screen")).toBeTruthy();
    const transcript = view.getByRole("log");
    expect(transcript.scrollTop).toBe(0);
    expect(transcript.querySelector(".virtual-transcript")?.getAttribute("style")).toContain("height: 180px");
  });

  it("does not infer an anchor when an empty start screen is replaced by a thread", async () => {
    const view = render(<Fixture messages={[]} />);
    view.rerender(<Fixture messages={[oldMessage, originalPrompt]} />);

    await waitFor(() => expect(view.getByRole("log").scrollTop).toBe(1_000));
    expect(view.container.querySelector(".transcript-current-row")).toBeNull();
  });

  it("keeps the same pending anchor when a draft session receives its real ID", async () => {
    const prompt: UiMessage = { id: "local-draft", role: "user", text: "Create the project", timestamp: 7_000 };
    const turnStart: TranscriptTurnStart = {
      turnId: "logical-draft-turn",
      sessionId: "draft:/project",
      messageId: prompt.id,
      text: prompt.text,
      timestamp: prompt.timestamp,
      preserveAcrossSessionChange: true,
    };
    const view = render(<Fixture messages={[prompt]} sessionId="draft:/project" turnStart={turnStart} />);
    await waitFor(() => expect(view.container.querySelector('.transcript-current-row[data-message-id="local-draft"]')).toBeTruthy());

    const persisted: UiMessage = { ...prompt, id: "saved-draft" };
    view.rerender(<Fixture
      messages={[persisted]}
      sessionId="real-session"
      turnStart={{ ...turnStart, sessionId: "real-session", messageId: persisted.id }}
    />);

    await waitFor(() => expect(view.container.querySelector('.transcript-current-row[data-message-id="saved-draft"]')).toBeTruthy());
    expect(view.container.querySelector('[data-message-id="local-draft"]')).toBeNull();
  });

  it("anchors a follow-up when its explicit submitted message arrives later", async () => {
    const turnStart: TranscriptTurnStart = {
      turnId: "logical-follow-up",
      sessionId: "one",
      text: "Continue the work",
      timestamp: 10_000,
      awaitingMessage: true,
    };
    const view = render(<Fixture
      messages={[oldMessage, originalPrompt]}
      sessionId="one"
      turnStart={turnStart}
    />);
    await waitFor(() => expect(view.container.querySelector(".transcript-current-row")).toBeNull());

    const persisted: UiMessage = {
      id: "saved-follow-up",
      role: "user",
      text: turnStart.text!,
      timestamp: turnStart.timestamp!,
    };
    view.rerender(<Fixture
      messages={[oldMessage, originalPrompt, persisted]}
      sessionId="one"
      turnStart={turnStart}
    />);

    await waitFor(() => expect(view.container.querySelector('.transcript-current-row[data-message-id="saved-follow-up"]')).toBeTruthy());
  });

  it("resets an explicit anchor on a normal thread switch", async () => {
    const prompt: UiMessage = { id: "local-thread", role: "user", text: "Stay here", timestamp: 8_000 };
    const turnStart: TranscriptTurnStart = { turnId: "logical-thread-turn", sessionId: "one", messageId: prompt.id, text: prompt.text, timestamp: prompt.timestamp };
    const view = render(<Fixture
      messages={[oldMessage, originalPrompt, prompt]}
      sessionId="one"
      turnStart={turnStart}
    />);
    await waitFor(() => expect(view.container.querySelector('.transcript-current-row[data-message-id="local-thread"]')).toBeTruthy());

    view.rerender(<Fixture
      messages={[{ id: "new-thread", role: "user", text: "Other thread", timestamp: 9_000 }]}
      sessionId="two"
      turnStart={{ ...turnStart, sessionId: "one" }}
    />);
    await waitFor(() => expect(view.getByRole("log").scrollTop).toBe(1_000));
    expect(view.container.querySelector(".transcript-current-row")).toBeNull();
  });

  it("clears the current-turn marker when the send signal is withdrawn", async () => {
    const prompt: UiMessage = { id: "local-clear", role: "user", text: "Failed send", timestamp: 9_500 };
    const view = render(<Fixture
      messages={[prompt]}
      turnStart={{ turnId: "logical-clear", sessionId: "one", messageId: prompt.id, text: prompt.text, timestamp: prompt.timestamp }}
    />);
    await waitFor(() => expect(view.container.querySelector(".transcript-current-row")).toBeTruthy());

    view.rerender(<Fixture messages={[prompt]} />);
    await waitFor(() => expect(view.container.querySelector(".transcript-current-row")).toBeNull());
  });

  it("keeps the pinned prompt in place while an answer grows below it", async () => {
    const prompt: UiMessage = { id: "local-2", role: "user", text: "Explain this", timestamp: 4_000 };
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const turnStart = { turnId: "turn-2", sessionId: "one", messageId: "local-2", text: prompt.text, timestamp: prompt.timestamp };
    view.rerender(<Fixture messages={[oldMessage, originalPrompt, prompt]} turnStart={turnStart} />);
    const current = await waitFor(() => view.container.querySelector(".transcript-current-row"));
    const promptRow = view.container.querySelector('[data-message-id="local-2"]');
    expect(promptRow).toBeTruthy();

    const answer: UiMessage = { id: "answer-2", role: "assistant", text: "Here is the answer", timestamp: 5_000 };
    view.rerender(<Fixture messages={[oldMessage, originalPrompt, prompt, answer]} turnStart={turnStart} />);

    await waitFor(() => expect(view.container.textContent).toContain("Here is the answer"));
    expect(view.container.querySelector(".transcript-current-row[data-message-id=\"local-2\"]")).toBe(promptRow);
  });

  it("does not reactivate following when an optimistic id becomes authoritative after history navigation", async () => {
    const optimistic: UiMessage = { id: "local-3", role: "user", text: "Continue", timestamp: 6_000 };
    const authoritative: UiMessage = { id: "saved-3", role: "user", text: "Continue", timestamp: 6_000 };
    const view = render(<Fixture messages={[oldMessage, originalPrompt]} />);
    const turnStart = { turnId: "turn-3", sessionId: "one", messageId: optimistic.id, text: optimistic.text, timestamp: optimistic.timestamp };
    view.rerender(<Fixture messages={[oldMessage, originalPrompt, optimistic]} turnStart={turnStart} />);
    await waitFor(() => expect(view.container.querySelector(".transcript-current-row")).toBeTruthy());

    const transcript = view.getByRole("log");
    fireEvent.wheel(transcript, { deltaY: -100 });
    act(() => {
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
    });
    await view.findByRole("button", { name: "Jump to latest" });

    view.rerender(<Fixture messages={[oldMessage, originalPrompt, authoritative]} turnStart={turnStart} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Jump to latest" })).toBeTruthy());
    expect(view.container.querySelector(".transcript-current-row")).toBeNull();
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
