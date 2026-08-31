// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactTimestamp, fullTimestamp, isLongMessage, localImagePaths, Message, withoutLocalImagePaths } from "./Message";

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

    fireEvent.click(screen.getByRole("button", { name: "Open image 1" }));
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });
});

describe("Long user messages", () => {
  const message = (text: string) => ({ id: "long", role: "user" as const, text, timestamp: 0 });

  it("uses both the line and character thresholds", () => {
    expect(isLongMessage(Array.from({ length: 8 }, () => "line").join("\n"))).toBe(false);
    expect(isLongMessage(Array.from({ length: 9 }, () => "line").join("\n"))).toBe(true);
    expect(isLongMessage("x".repeat(600))).toBe(false);
    expect(isLongMessage("x".repeat(601))).toBe(true);
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

  it("preserves a visible row anchor after virtualizer remeasurement in both directions", async () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "transcript";
    scrollContainer.scrollTop = 240;
    document.body.append(scrollContainer);
    const text = "x".repeat(601);
    try {
      render(
        <>
          <div className="virtual-transcript-row"><Message message={message(text)} /></div>
          <div className="virtual-transcript-row">Current reading anchor</div>
        </>,
        { container: scrollContainer },
      );
      const content = scrollContainer.querySelector(".message-text-content") as HTMLElement;
      const rows = [...scrollContainer.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
      const anchor = rows[1];
      scrollContainer.getBoundingClientRect = () => ({ top: 0, bottom: 400, height: 400, left: 0, right: 780, width: 780, x: 0, y: 0, toJSON: () => ({}) });
      rows[0].getBoundingClientRect = () => ({ top: -200, bottom: content.classList.contains("collapsed") ? 100 : 300, height: content.classList.contains("collapsed") ? 300 : 500, left: 0, right: 780, width: 780, x: 0, y: -200, toJSON: () => ({}) });
      anchor.getBoundingClientRect = () => ({ top: content.classList.contains("collapsed") ? 300 : 500, bottom: 340, height: 40, left: 0, right: 780, width: 780, x: 0, y: 0, toJSON: () => ({}) });

      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await waitFor(() => expect(scrollContainer.scrollTop).toBe(440));
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      await waitFor(() => expect(scrollContainer.scrollTop).toBe(240));
    } finally {
      scrollContainer.remove();
    }
  });

  it("passes the full message to copy while the preview is collapsed", () => {
    const onCopy = vi.fn();
    const longText = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join("\n");
    const fullMessage = message(longText);
    render(<Message message={fullMessage} onCopy={onCopy} />);

    fireEvent.click(screen.getByTitle("Copy message"));
    expect(onCopy).toHaveBeenCalledWith(fullMessage);
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
