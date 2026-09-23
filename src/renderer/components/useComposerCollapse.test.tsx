// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { COLLAPSE_DISTANCE_PX, scrollGestureStep, useComposerCollapse, type ScrollGesture } from "./useComposerCollapse";

afterEach(cleanup);

describe("folding the composer while scrolling", () => {
  it("folds after a gesture back through the transcript, not after a pause or a turn toward the end", () => {
    const gesture: ScrollGesture = { distance: 0, at: 0 };
    expect(scrollGestureStep(gesture, -60, 10)).toBe(false);
    expect(scrollGestureStep(gesture, -60, 20)).toBe(true);
    const paused: ScrollGesture = { distance: 0, at: 0 };
    scrollGestureStep(paused, -100, 10);
    expect(scrollGestureStep(paused, -40, 1_000)).toBe(false);
    const turned: ScrollGesture = { distance: 0, at: 0 };
    scrollGestureStep(turned, -100, 10);
    scrollGestureStep(turned, 10, 20);
    expect(scrollGestureStep(turned, -40, 30)).toBe(false);
    expect(COLLAPSE_DISTANCE_PX).toBeGreaterThan(0);
  });

  function Harness({ enabled = true, idle = true }: { enabled?: boolean; idle?: boolean }) {
    const zoneRef = useRef<HTMLElement>(null);
    const { collapsed } = useComposerCollapse({ enabled, idle, zoneRef });
    return <>
      <div className="transcript" data-testid="transcript"><p>history</p></div>
      <footer ref={zoneRef} data-testid="zone" data-collapsed={collapsed ? "yes" : "no"}><textarea /></footer>
    </>;
  }

  function scrolled(transcript: HTMLElement, top: number) {
    Object.defineProperties(transcript, {
      scrollTop: { configurable: true, value: top },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
  }

  it("folds on a scroll back, and unfolds on a key, a press, or the transcript's end", () => {
    const view = render(<Harness />);
    const transcript = view.getByTestId("transcript");
    const zone = view.getByTestId("zone");
    scrolled(transcript, 900);
    act(() => { fireEvent.wheel(transcript.firstElementChild!, { deltaY: -200 }); });
    expect(zone.dataset.collapsed).toBe("yes");
    act(() => { fireEvent.keyDown(zone.querySelector("textarea")!, { key: "a" }); });
    expect(zone.dataset.collapsed).toBe("no");

    act(() => { fireEvent.wheel(transcript, { deltaY: -200 }); });
    expect(zone.dataset.collapsed).toBe("yes");
    scrolled(transcript, 1_600);
    act(() => { fireEvent.wheel(transcript, { deltaY: 40 }); });
    expect(zone.dataset.collapsed).toBe("no");
  });

  it("stays open while the composer is busy or the option is off", () => {
    const busy = render(<Harness idle={false} />);
    scrolled(busy.getByTestId("transcript"), 900);
    act(() => { fireEvent.wheel(busy.getByTestId("transcript"), { deltaY: -400 }); });
    expect(busy.getByTestId("zone").dataset.collapsed).toBe("no");
    cleanup();
    const off = render(<Harness enabled={false} />);
    scrolled(off.getByTestId("transcript"), 900);
    act(() => { fireEvent.wheel(off.getByTestId("transcript"), { deltaY: -400 }); });
    expect(off.getByTestId("zone").dataset.collapsed).toBe("no");
  });
});
