// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { connectPreviewHost } from "./store.js";
import { PortSuggestions } from "./suggestions.js";

let hidden = false;
let disconnect: () => void = () => undefined;
afterEach(() => { cleanup(); disconnect(); vi.useRealTimers(); hidden = false; Reflect.deleteProperty(document, "hidden"); });

function host() {
  const invoke = vi.fn(async (command: string) => command === "ports" ? [{ url: "http://localhost:5173/", port: 5173, inWorkspace: true, html: true }] : undefined);
  disconnect = connectPreviewHost({ invoke, onEvent: () => () => undefined });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  return () => invoke.mock.calls.filter(([command]) => command === "ports").length;
}

it("scans when shown and when the address field takes focus, not on a timer or while hidden", async () => {
  vi.useFakeTimers();
  const scans = host();
  const view = render(<PortSuggestions current="" onOpen={() => undefined} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("localhost:5173")).toBeTruthy();
  expect(scans()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(scans()).toBe(1);
  view.rerender(<PortSuggestions current="" focused onOpen={() => undefined} />);
  expect(scans()).toBe(2);
  view.rerender(<PortSuggestions current="" onOpen={() => undefined} />);
  expect(scans()).toBe(2);
  hidden = true;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  view.rerender(<PortSuggestions current="" focused onOpen={() => undefined} />);
  expect(scans()).toBe(2);
  hidden = false;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(scans()).toBe(3);
});
