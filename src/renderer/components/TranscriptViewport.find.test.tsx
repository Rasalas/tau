// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";

vi.mock("./VirtualTranscript", () => ({
  VirtualTranscript: ({ messages }: { messages: UiMessage[] }) => <div>{messages.map((message) => <div key={message.id} data-message-id={message.id}>{message.text}</div>)}</div>,
}));

import { TranscriptViewport } from "./TranscriptViewport";
import { requestFind } from "./transcript-reveal";

afterEach(cleanup);

const messages: UiMessage[] = [{ id: "a", role: "assistant", text: "An answer", timestamp: 1 }];

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return <>
    <TranscriptViewport messages={messages} scrollRef={scrollRef} sessionId="one" isStreaming={false} />
    <textarea aria-label="Composer" />
  </>;
}

describe("find in the transcript", () => {
  it("opens when the find command asks, with the keyboard in the composer, and takes the keyboard back when asked again", async () => {
    const view = render(<Fixture />);
    const composer = view.getByLabelText("Composer");
    composer.focus();
    act(() => requestFind(view.getByRole("log")));
    const input = await view.findByPlaceholderText("Find in transcript…");
    await waitFor(() => expect(document.activeElement).toBe(input));

    composer.focus();
    act(() => requestFind(view.getByRole("log")));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("seeds the find from a palette hit and selects the matching message", async () => {
    const view = render(<Fixture />);
    act(() => requestFind(view.getByRole("log"), "answer"));
    const input = await view.findByPlaceholderText("Find in transcript…") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("answer"));
    expect(view.getByText("1 of 1")).toBeTruthy();
  });

  it("opens on / in the transcript, and leaves the find chord to the command", async () => {
    const view = render(<Fixture />);
    const log = view.getByRole("log");
    // ⌘F and Ctrl+F reach the window's keybindings as `thread.find`; the transcript does not take them itself.
    expect(fireEvent.keyDown(log, { key: "f", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(log, { key: "f", ctrlKey: true })).toBe(true);
    expect(view.queryByRole("search")).toBeNull();
    expect(fireEvent.keyDown(log, { key: "/" })).toBe(false);
    expect(await view.findByRole("search", { name: "Search transcript" })).toBeTruthy();
  });

  it("reserves the bar's room at the top of the transcript while it is open", async () => {
    const view = render(<Fixture />);
    const viewport = view.getByRole("log").parentElement!;
    expect(viewport.classList.contains("with-find")).toBe(false);
    act(() => requestFind(view.getByRole("log")));
    const input = await view.findByPlaceholderText("Find in transcript…");
    expect(viewport.classList.contains("with-find")).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(viewport.classList.contains("with-find")).toBe(false));
  });

  it("pads the open transcript past the bar's bottom edge (12px from the top, 32px high)", async () => {
    const css = (await readFile(resolve(__dirname, "../styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
    const rule = css.match(/\.transcript-viewport\.with-find \.transcript\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(Number(rule.match(/padding-top:[^;]*,\s*(\d+)px\)/u)?.[1])).toBeGreaterThanOrEqual(12 + 32 + 8);
  });

  it("does nothing without a transcript", () => {
    expect(() => requestFind(null)).not.toThrow();
    expect(() => requestFind(document.createElement("div"))).not.toThrow();
  });
});
