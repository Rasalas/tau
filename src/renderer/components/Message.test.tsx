// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactTimestamp, fullTimestamp, isLongMessage, localImagePaths, Message, visibleUserMessageText, withoutLocalImagePaths } from "./Message";
import { fallbackGraphemeCount, GRAPHEME_CODEPOINT_BUDGET } from "./message-grapheme";

afterEach(cleanup);

describe("Message images", () => {
  it("finds shell-escaped local image paths", () => {
    const text = "/Users/me/Application\\ Support/CleanShot/image.png please inspect";
    expect(localImagePaths(text)).toEqual(["/Users/me/Application Support/CleanShot/image.png"]);
    expect(withoutLocalImagePaths(text)).toBe("please inspect");
  });

  it("renders image content persisted in the Pi message", () => {
    render(<Message message={{
      id: "user-image",
      role: "user",
      text: "please inspect",
      images: [{ mimeType: "image/png", data: "iVBORw==" }],
      timestamp: 0,
    }} />);

    const image = screen.getByRole("img", { name: "Attached image" }) as HTMLImageElement;
    expect(image.src).toBe("data:image/png;base64,iVBORw==");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("opens and closes persisted images in an accessible lightbox", () => {
    render(<Message message={{
      id: "user-image",
      role: "user",
      text: "please inspect",
      images: [{ mimeType: "image/png", data: "iVBORw==" }],
      timestamp: 0,
    }} />);

    const openButton = screen.getByRole("button", { name: "Open image 1" });
    openButton.focus();
    fireEvent.click(openButton);
    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(dialog).toBeTruthy();
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    const closeButton = screen.getByRole("button", { name: "Close preview" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(document.activeElement).toBe(openButton);

    fireEvent.click(openButton);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Image preview" }));
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(document.activeElement).toBe(openButton);
  });
});

describe("Long user messages", () => {
  const message = (text: string) => ({ id: "long", role: "user" as const, text, timestamp: 0 });

  it("uses both the line and character thresholds", () => {
    expect(isLongMessage(Array.from({ length: 8 }, () => "line").join("\n"))).toBe(false);
    expect(isLongMessage(Array.from({ length: 9 }, () => "line").join("\n"))).toBe(true);
    expect(isLongMessage("x".repeat(600))).toBe(false);
    expect(isLongMessage("x".repeat(601))).toBe(true);
    // These are visible graphemes, not UTF-16 code units.
    expect(isLongMessage("e\u0301".repeat(301))).toBe(false);
    expect(isLongMessage("a".repeat(600) + "\u0301")).toBe(false);
    expect(isLongMessage("a".repeat(601))).toBe(true);
    expect(isLongMessage("😀".repeat(300))).toBe(false);
    expect(isLongMessage("😀".repeat(301))).toBe(false);
    expect(isLongMessage("😀".repeat(600))).toBe(false);
    expect(isLongMessage("😀".repeat(600) + "a")).toBe(true);
    expect(isLongMessage("e\u0301".repeat(600))).toBe(false);
    expect(isLongMessage("e\u0301".repeat(600) + "e\u0301")).toBe(true);
      expect(isLongMessage("👨‍👩‍👧‍👦".repeat(600))).toBe(false);
      expect(isLongMessage("👨‍👩‍👧‍👦".repeat(600) + "👨‍👩‍👧‍👦")).toBe(true);
  });

  it("keeps the grapheme fallback bounded for Hangul Jamo clusters", () => {
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    try {
      expect(isLongMessage("각".repeat(201))).toBe(false);
      expect(isLongMessage("👨‍👩‍👧‍👦".repeat(600))).toBe(false);
      expect(isLongMessage("👨‍👩‍👧‍👦".repeat(601))).toBe(true);
      // GB11 joins only Extended_Pictographic after a ZWJ. The ordinary
      // `a` remains a separate visible grapheme.
      expect(isLongMessage(("👨‍a".repeat(300)) + "👨")).toBe(true);
      expect(isLongMessage("a\u200db".repeat(301))).toBe(true);
      expect(isLongMessage("\u0301\u0302" + "a".repeat(599))).toBe(false);
      expect(isLongMessage("\u0301\u0302" + "a".repeat(600))).toBe(true);
      expect(isLongMessage("각".repeat(600) + "ᄀ")).toBe(true);
      expect(isLongMessage("각".repeat(600))).toBe(false);
      expect(isLongMessage("각".repeat(600) + "가")).toBe(true);
      expect(isLongMessage("가ᅡ".repeat(600))).toBe(false);
      // An unbounded extender tail is conservative once the fallback budget
      // is exhausted, even though the visible prefix is one cluster.
      expect(isLongMessage("각" + "\u200d\u0301".repeat(10_000))).toBe(true);
      expect(isLongMessage("👨‍👩‍👧‍👦".repeat(601))).toBe(true);
      expect(isLongMessage("\u0301".repeat(10_000) + "a".repeat(601))).toBe(true);
      // An extender without a preceding base starts its own grapheme. Once a
      // base exists, the same extender remains attached to that cluster.
      expect(isLongMessage("\u0301" + "a".repeat(600))).toBe(true);
      expect(isLongMessage("\ufe0f" + "a".repeat(600))).toBe(true);
      expect(isLongMessage("\u{1f3fb}" + "a".repeat(600))).toBe(true);
      expect(isLongMessage("\u200d" + "a".repeat(600))).toBe(true);
      expect(isLongMessage("e\u0301".repeat(301))).toBe(false);
      const bounded = fallbackGraphemeCount("\u0301".repeat(10_000_000), 600);
      expect(bounded.exhausted).toBe(true);
      expect(bounded.examinedCodePoints).toBe(GRAPHEME_CODEPOINT_BUDGET);
    } finally {
      if (segmenter) Object.defineProperty(Intl, "Segmenter", segmenter);
    }
  });

  it("starts long messages collapsed and toggles the complete content", () => {
    const text = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join("\n");
    const view = render(<Message message={message(text)} />);

    const content = view.container.querySelector(".message-text-content") as HTMLElement;
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.getAttribute("data-collapsed")).toBe("true");
    expect(content.className).toContain("collapsed");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    expect(content.getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the transcript scroll position when toggled", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflow = "auto";
    scrollContainer.scrollTop = 240;
    document.body.append(scrollContainer);
    render(<Message message={message("x".repeat(601))} />, { container: scrollContainer });

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(scrollContainer.scrollTop).toBe(240);
  });

  it("passes the full message to copy while the preview is collapsed", () => {
    const onCopy = vi.fn();
    const longText = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join("\n");
    const fullMessage = message(longText);
    render(<Message message={fullMessage} onCopy={onCopy} />);

    fireEvent.click(screen.getByTitle("Copy message"));
    expect(onCopy).toHaveBeenCalledWith(fullMessage);
  });

  it("copies visible user text without local image path wrappers", () => {
    const onCopy = vi.fn();
    const fullMessage = message(`/tmp/CleanShot/image.png\n${Array.from({ length: 9 }, (_, index) => `Caption ${index + 1}`).join("\n")}`);
    render(<Message message={fullMessage} onCopy={onCopy} />);

    expect(visibleUserMessageText(fullMessage.text)).toContain("Caption 1");
    fireEvent.click(screen.getByTitle("Copy message"));
    expect(onCopy).toHaveBeenCalledWith({ ...fullMessage, text: Array.from({ length: 9 }, (_, index) => `Caption ${index + 1}`).join("\n") });
    expect(onCopy.mock.calls[0][0].text).not.toContain("/tmp/CleanShot/image.png");
  });
});

describe("Message timestamps", () => {
  it("exposes a compact local date/time and the full local value accessibly", () => {
    const timestamp = Date.UTC(2024, 0, 2, 3, 4, 5);
    render(<Message message={{ id: "timestamp", role: "user", text: "hello", timestamp }} />);

    const time = screen.getByRole("time");
    expect(time.textContent).toContain(compactTimestamp(timestamp));
    expect(time.getAttribute("dateTime")).toBe(new Date(timestamp).toISOString());
    expect(time.getAttribute("title")).toBe(fullTimestamp(timestamp));
    expect(time.getAttribute("aria-label")).toBe(`Sent ${fullTimestamp(timestamp)}`);
  });
});

describe("Message actions", () => {
  it("copies and forks a persisted message", () => {
    const onCopy = vi.fn();
    const onFork = vi.fn();
    const message = { id: "message", sourceEntryId: "entry", role: "assistant" as const, text: "Answer", timestamp: 0 };
    render(<Message message={message} onCopy={onCopy} onFork={onFork} />);

    fireEvent.click(screen.getByTitle("Copy message"));
    fireEvent.click(screen.getByTitle("Fork through this message"));
    expect(onCopy).toHaveBeenCalledWith(message);
    expect(onFork).toHaveBeenCalledWith(message);
  });

  it("does not offer a fork for an optimistic message", () => {
    render(<Message
      message={{ id: "local", role: "user", text: "Pending", timestamp: 0 }}
      onCopy={() => {}}
      onFork={() => {}}
    />);
    expect(screen.queryByTitle("Fork through this message")).toBeNull();
  });
});

describe("Message reasoning presentation", () => {
  it("keeps provider reasoning summaries out of the transcript", () => {
    const view = render(<Message message={{
      id: "assistant",
      role: "assistant",
      text: "Visible answer",
      thinking: "Internal reasoning summary",
      timestamp: 0,
    }} />);

    expect(screen.getByText("Visible answer")).toBeTruthy();
    expect(screen.queryByText("Internal reasoning summary")).toBeNull();
    expect(view.container.textContent).not.toContain("thinking");
  });

  it("does not render an empty thinking placeholder", () => {
    const view = render(<Message message={{ id: "working", role: "assistant", text: "", timestamp: 0 }} />);
    expect(view.container.textContent).toBe("");
  });
});

describe("Message async activity", () => {
  it("collapses subagent completion payloads behind a compact activity row", () => {
    const payload = 'Background task completed: **workflow** Workflow completed with 2 child run(s). Return: [{"key":"review","output":"large payload"}]';
    render(<Message message={{ id: "activity", role: "user", text: payload, timestamp: 0 }} />);

    expect(screen.getByText("2 subagent runs completed")).toBeTruthy();
    expect(screen.queryByText(/large payload/)).toBeNull();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/large payload/)).toBeTruthy();
  });

  it("collapses subagent attention notices", () => {
    const payload = "Subagent needs attention: reviewer Run: abc Signal: reviewer has had tool grep open for 240s";
    render(<Message message={{ id: "attention", role: "user", text: payload, timestamp: 0 }} />);

    expect(screen.getByText("Subagent needs attention")).toBeTruthy();
    expect(screen.queryByText(/tool grep open/)).toBeNull();
  });
});
