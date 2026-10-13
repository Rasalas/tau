// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileComposerFold } from "./useMobileComposerFold";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => window.clearTimeout(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function Harness({ enabled = true, idle = true }: { enabled?: boolean; idle?: boolean }) {
  const zoneRef = useRef<HTMLElement>(null);
  useMobileComposerFold({ enabled, idle: () => idle, zoneRef });
  return <section className="conversation-column">
    <div className="transcript" data-testid="transcript"><p>history</p></div>
    <footer ref={zoneRef} className="composer-zone" data-testid="zone">
      <textarea /><div className="composer-toolbar"><button>Model</button></div>
    </footer>
  </section>;
}

function mount(props: { enabled?: boolean; idle?: boolean } = {}) {
  const view = render(<Harness {...props} />);
  const transcript = view.getByTestId("transcript");
  const zone = view.getByTestId("zone");
  const toolbar = zone.querySelector<HTMLElement>(".composer-toolbar")!;
  const scrollToDistance = (distance: number) => {
    Object.defineProperties(transcript, {
      scrollTop: { configurable: true, value: 1_600 - distance },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    fireEvent.scroll(transcript);
    act(() => { vi.advanceTimersByTime(0); });
  };
  const progress = () => Number(zone.style.getPropertyValue("--composer-fold"));
  return { view, transcript, zone, toolbar, scrollToDistance, progress };
}

describe("the mobile composer follows the transcript", () => {
  it("shrinks continuously beyond the end buffer and follows a reversal", () => {
    const { transcript, zone, toolbar, scrollToDistance, progress } = mount();
    fireEvent.touchStart(transcript);
    scrollToDistance(20);
    expect(progress()).toBe(0);
    scrollToDistance(72);
    expect(progress()).toBeCloseTo(0.5);
    expect(zone.classList.contains("folding")).toBe(true);
    expect(zone.classList.contains("fold-following")).toBe(true);
    expect(toolbar.inert).toBe(true);
    scrollToDistance(120);
    expect(progress()).toBe(1);
    fireEvent.touchEnd(transcript);
    fireEvent.touchStart(transcript);
    scrollToDistance(96);
    expect(progress()).toBeCloseTo(0.75);
    scrollToDistance(24);
    expect(progress()).toBe(0);
    expect(zone.classList.contains("folding")).toBe(false);
    expect(toolbar.inert).toBe(false);
  });

  it("waits for a completed tap, then opens without later momentum folding it again", () => {
    const { transcript, zone, toolbar, scrollToDistance, progress } = mount();
    fireEvent.wheel(transcript, { deltaY: -200 });
    expect(progress()).toBe(0);
    scrollToDistance(150);
    expect(progress()).toBe(1);
    const field = zone.querySelector("textarea")!;
    fireEvent.pointerDown(field);
    fireEvent.focusIn(field);
    expect(progress()).toBe(1);
    fireEvent.pointerUp(field);
    expect(progress()).toBe(1);
    fireEvent.click(field);
    expect(progress()).toBe(0);
    expect(zone.classList.contains("fold-following")).toBe(false);
    // Keep the end reservation and clipped controls intact during the opening animation.
    expect(zone.classList.contains("folding")).toBe(true);
    expect(toolbar.inert).toBe(true);
    scrollToDistance(200);
    expect(progress()).toBe(0);
    act(() => { vi.advanceTimersByTime(180); });
    expect(zone.classList.contains("folding")).toBe(false);
    expect(toolbar.inert).toBe(false);
  });

  it("ignores programmatic scrolling away from the end and another thread", () => {
    const { transcript, scrollToDistance, progress } = mount();
    scrollToDistance(200);
    expect(progress()).toBe(0);
    const other = document.createElement("div");
    other.className = "transcript";
    document.body.append(other);
    fireEvent.touchStart(other);
    scrollToDistance(300);
    expect(progress()).toBe(0);
    other.remove();
    fireEvent.touchStart(transcript);
    scrollToDistance(200);
    expect(progress()).toBe(1);
    scrollToDistance(0);
    expect(progress()).toBe(0);
  });

  it("opens when a draft, attachment, keyboard or question makes it busy, and cleans up when disabled", () => {
    const { view, transcript, toolbar, zone, scrollToDistance, progress } = mount();
    fireEvent.touchStart(transcript);
    scrollToDistance(72);
    expect(progress()).toBe(0.5);
    view.rerender(<Harness idle={false} />);
    expect(progress()).toBe(0);
    scrollToDistance(200);
    expect(progress()).toBe(0);
    view.rerender(<Harness />);
    fireEvent.touchStart(transcript);
    scrollToDistance(200);
    expect(progress()).toBe(1);
    view.rerender(<Harness enabled={false} />);
    expect(zone.style.getPropertyValue("--composer-fold")).toBe("");
    expect(zone.classList.contains("folding")).toBe(false);
    expect(toolbar.inert).toBe(false);
  });

  it("unfolds on keyboard focus or a key without requiring a touch", () => {
    const { transcript, zone, scrollToDistance, progress } = mount();
    fireEvent.touchStart(transcript);
    scrollToDistance(150);
    fireEvent.focusIn(zone.querySelector("textarea")!);
    expect(progress()).toBe(0);
    fireEvent.touchStart(transcript);
    scrollToDistance(150);
    fireEvent.keyDown(zone.querySelector("textarea")!, { key: "a" });
    expect(progress()).toBe(0);
  });

  it("opens immediately with reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { transcript, zone, toolbar, scrollToDistance, progress } = mount();
    fireEvent.touchStart(transcript);
    scrollToDistance(72);
    fireEvent.click(zone.querySelector("textarea")!);
    expect(progress()).toBe(0);
    expect(zone.classList.contains("folding")).toBe(false);
    expect(toolbar.inert).toBe(false);
  });

  it("cancels a pending scroll frame when another touch or editing takes over", () => {
    const { transcript, zone, progress } = mount();
    Object.defineProperties(transcript, {
      scrollTop: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    fireEvent.touchStart(transcript);
    fireEvent.scroll(transcript);
    fireEvent.touchStart(document.body);
    act(() => { vi.advanceTimersByTime(0); });
    expect(progress()).toBe(0);
    fireEvent.touchStart(transcript);
    fireEvent.scroll(transcript);
    fireEvent.keyDown(zone.querySelector("textarea")!, { key: "a" });
    act(() => { vi.advanceTimersByTime(0); });
    expect(progress()).toBe(0);
  });
});
