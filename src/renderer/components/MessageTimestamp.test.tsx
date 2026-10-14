// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Message } from "./Message";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

describe("message timestamps", () => {
  it("picks up a changed system timezone without a renderer reload", () => {
    const original = process.env.TZ;
    const timestamp = Date.UTC(2024, 6, 2, 15, 4, 5);
    try {
      process.env.TZ = "UTC";
      fullTimestamp(timestamp);
      compactTimestamp(timestamp);
      process.env.TZ = "America/New_York";
      expect(fullTimestamp(timestamp)).toBe(new Date(timestamp).toLocaleString([], { dateStyle: "full", timeStyle: "long", hour12: false }));
      expect(compactTimestamp(timestamp)).toBe(new Date(timestamp).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }));
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it.each([NaN, Infinity, 9e15])("keeps invalid timestamp formatting non-throwing for %s", (timestamp) => {
    const invalid = new Date(timestamp).toLocaleString();
    expect(fullTimestamp(timestamp)).toBe(invalid);
    expect(compactTimestamp(timestamp)).toBe(invalid);
  });
  it("keeps the selected hour cycle and locale format when preferences change", () => {
    const timestamp = Date.UTC(2024, 6, 2, 15, 4, 5);
    const original = document.documentElement.dataset.timestamps;
    try {
      for (const format of ["24h", "12h", "locale", "24h", "12h"]) {
        document.documentElement.dataset.timestamps = format;
        const hour = format === "locale" ? {} : { hour12: format === "12h" };
        expect(fullTimestamp(timestamp)).toBe(new Date(timestamp).toLocaleString([], { dateStyle: "full", timeStyle: "long", ...hour }));
        expect(compactTimestamp(timestamp)).toBe(new Date(timestamp).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", ...hour }));
      }
    } finally {
      if (original === undefined) delete document.documentElement.dataset.timestamps;
      else document.documentElement.dataset.timestamps = original;
    }
  });

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
