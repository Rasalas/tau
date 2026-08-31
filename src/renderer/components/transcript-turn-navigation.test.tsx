// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import {
  buildTranscriptTurnNavigation,
  MIN_TRANSCRIPT_TURN_NAVIGATION_TURNS,
  normalizePromptPreview,
  shouldShowTranscriptTurnNavigation,
  truncatePromptPreview,
} from "./transcript-turn-navigation";
import { visibleTranscriptTurnId } from "./TranscriptViewport";

vi.mock("./VirtualTranscript", () => ({
  VirtualTranscript: ({ messages }: { messages: UiMessage[] }) => (
    <div className="virtual-transcript" style={{ height: `${messages.length * 180}px` }}>
      {messages.map((message, index) => (
        <div
          key={message.id}
          className="virtual-transcript-row"
          data-index={index}
          data-message-id={message.id}
          style={{ transform: `translateY(${index * 180}px)` }}
        >
          {message.text}
        </div>
      ))}
    </div>
  ),
}));

import { TranscriptViewport } from "./TranscriptViewport";

afterEach(cleanup);

function userMessages(count: number): UiMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `user-${index + 1}`,
    role: "user" as const,
    text: `Prompt ${index + 1}`,
    timestamp: index + 1,
  }));
}

function Fixture({ messages }: { messages: UiMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || Object.prototype.hasOwnProperty.call(node, "scrollHeight")) return;
    Object.defineProperties(node, {
      scrollHeight: { configurable: true, get: () => messagesRef.current.length * 180 },
      clientHeight: { configurable: true, get: () => 400 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollTo: {
        configurable: true,
        value: ({ top }: { top: number }) => { node.scrollTop = top; },
      },
    });
  }, [messages.length]);

  return <TranscriptViewport messages={messages} scrollRef={scrollRef} isStreaming={false} />;
}

describe("transcript turn navigation data", () => {
  it("creates one entry per loaded user turn and collapses prompt whitespace", () => {
    const entries = buildTranscriptTurnNavigation([
      { id: "assistant", role: "assistant", text: "Answer", timestamp: 1 },
      { id: "user-1", role: "user", text: "First\n\n  prompt", timestamp: 2 },
      { id: "notice", role: "notice", text: "Notice", timestamp: 3 },
      { id: "user-2", role: "user", text: "Second prompt", timestamp: 4 },
    ]);

    expect(entries).toEqual([
      { messageId: "user-1", messageIndex: 1, turnNumber: 1, preview: "First prompt" },
      { messageId: "user-2", messageIndex: 3, turnNumber: 2, preview: "Second prompt" },
    ]);
  });

  it("truncates at a readable word boundary while keeping Unicode characters intact", () => {
    const preview = truncatePromptPreview("Choose the correct 🧭 direction before continuing the long task", 28);
    expect(preview).toBe("Choose the correct 🧭…");
    expect(preview).not.toContain("\n");
    expect(normalizePromptPreview("  one\t two\nthree  ")).toBe("one two three");
  });

  it("only enables the navigation at the eight-turn threshold", () => {
    const below = buildTranscriptTurnNavigation(userMessages(MIN_TRANSCRIPT_TURN_NAVIGATION_TURNS - 1));
    const atThreshold = buildTranscriptTurnNavigation(userMessages(MIN_TRANSCRIPT_TURN_NAVIGATION_TURNS));
    expect(shouldShowTranscriptTurnNavigation(below)).toBe(false);
    expect(shouldShowTranscriptTurnNavigation(atThreshold)).toBe(true);
  });
});

describe("TranscriptViewport turn navigation", () => {
  it("hides the turn list for short transcripts and renders accessible previews for long ones", async () => {
    const view = render(<Fixture messages={userMessages(7)} />);
    expect(view.queryByRole("navigation", { name: "Transcript turns" })).toBeNull();

    view.rerender(<Fixture messages={[
      ...userMessages(7),
      { id: "user-8", role: "user", text: "A very long prompt that should be shortened to a concise preview for the turn navigation list", timestamp: 8 },
    ]} />);

    const navigation = await waitFor(() => view.getByRole("navigation", { name: "Transcript turns" }));
    expect(navigation.getAttribute("aria-controls")).toBe("thread-transcript");
    expect(navigation.querySelectorAll("button")).toHaveLength(8);
    expect(navigation.querySelectorAll("button")[7]?.getAttribute("aria-label")).toContain("Go to turn 8:");
    expect(navigation.textContent).not.toContain("\n\n");
  });

  it("selects a turn with a button, enters reading mode, and stays there as content grows", async () => {
    const view = render(<Fixture messages={userMessages(8)} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_440));

    const firstTurn = view.getByRole("button", { name: "Go to turn 1: Prompt 1" });
    fireEvent.click(firstTurn);
    await waitFor(() => expect(transcript.scrollTop).toBe(0));
    expect(firstTurn.getAttribute("aria-current")).toBe("true");
    expect(view.getByRole("button", { name: "Jump to latest" })).toBeTruthy();

    view.rerender(<Fixture messages={[
      ...userMessages(8),
      { id: "assistant-tail", role: "assistant", text: "A growing answer", timestamp: 9 },
    ]} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript.scrollTop).toBe(0);
    expect(view.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("marks the turn visible at the current scroll position", async () => {
    const view = render(<Fixture messages={userMessages(8)} />);
    const transcript = view.getByRole("log");
    await waitFor(() => expect(transcript.scrollTop).toBe(1_440));

    // The existing navigation state intentionally ignores a synthetic layout
    // scroll while following the tail. Model the user's upward wheel intent
    // before applying the deterministic fixture position.
    fireEvent.wheel(transcript, { deltaY: -100 });
    actScroll(transcript, 650);
    await waitFor(() => expect(view.getByRole("button", { name: "Go to turn 5: Prompt 5" }).getAttribute("aria-current")).toBe("true"));
  });

  it("keeps navigation outside the transcript and composer flow", async () => {
    const view = render(<Fixture messages={userMessages(8)} />);
    const navigation = await waitFor(() => view.getByRole("navigation", { name: "Transcript turns" }));
    const transcript = view.getByRole("log");
    expect(navigation.parentElement).toBe(transcript.parentElement);
    expect(navigation.classList.contains("transcript-overlay")).toBe(false);
    expect(navigation.nextElementSibling).toBe(transcript);
  });
});

function actScroll(node: HTMLElement, top: number): void {
  node.scrollTop = top;
  fireEvent.scroll(node);
}
