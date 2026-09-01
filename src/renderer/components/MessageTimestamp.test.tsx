// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Message } from "./Message";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

describe("message timestamps", () => {
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
