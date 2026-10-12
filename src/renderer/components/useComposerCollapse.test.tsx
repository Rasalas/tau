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
    const { collapsed } = useComposerCollapse({ enabled, idle: () => idle, zoneRef });
    return <section className="conversation-column">
      <div className="transcript" data-testid="transcript"><p>history</p></div>
      <footer ref={zoneRef} data-testid="zone" data-collapsed={collapsed ? "yes" : "no"}><textarea /></footer>
    </section>;
  }

  function scrolled(transcript: HTMLElement, top: number) {
    Object.defineProperties(transcript, {
      scrollTop: { configurable: true, value: top },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
  }

  it("ignores scrolling another thread's transcript in the stage", () => {
    const view = render(<><Harness /><section className="stage"><div className="transcript" data-testid="agent">Agent history</div></section></>);
    const agent = view.getByTestId("agent");
    const transcript = view.getByTestId("transcript");
    const zone = view.getByTestId("zone");
    scrolled(agent, 900);
    scrolled(transcript, 900);
    fireEvent.wheel(agent, { deltaY: -200 });
    expect(zone.dataset.collapsed).toBe("no");
    fireEvent.wheel(transcript, { deltaY: -200 });
    expect(zone.dataset.collapsed).toBe("yes");
    scrolled(agent, 1_600);
    fireEvent.wheel(agent, { deltaY: 40 });
    expect(zone.dataset.collapsed).toBe("yes");
  });

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

  it("folds after actually scrolling history with a finger, and opens again at the end", () => {
    const view = render(<Harness />);
    const transcript = view.getByTestId("transcript");
    const zone = view.getByTestId("zone");
    scrolled(transcript, 1_600);
    fireEvent.touchStart(transcript);
    scrolled(transcript, 1_540);
    fireEvent.scroll(transcript);
    expect(zone.dataset.collapsed).toBe("no");
    fireEvent.touchEnd(transcript);
    scrolled(transcript, 1_460);
    fireEvent.scroll(transcript);
    expect(zone.dataset.collapsed).toBe("yes");
    scrolled(transcript, 1_600);
    fireEvent.scroll(transcript);
    expect(zone.dataset.collapsed).toBe("no");
  });

  it("ignores programmatic scrolling and cancels the reading gesture when the editor is tapped", () => {
    const view = render(<Harness />);
    const transcript = view.getByTestId("transcript");
    const zone = view.getByTestId("zone");
    scrolled(transcript, 900);
    fireEvent.scroll(transcript);
    expect(zone.dataset.collapsed).toBe("no");
    fireEvent.touchStart(transcript);
    scrolled(transcript, 700);
    fireEvent.scroll(transcript);
    expect(zone.dataset.collapsed).toBe("yes");
    fireEvent.pointerDown(zone.querySelector("textarea")!);
    expect(zone.dataset.collapsed).toBe("no");
    scrolled(transcript, 500);
    fireEvent.scroll(transcript);
    expect(zone.dataset.collapsed).toBe("no");
  });

  it.each([{ idle: false }, { enabled: false }])("keeps the editor open during a touch gesture with %j", (props) => {
    const view = render(<Harness {...props} />);
    const transcript = view.getByTestId("transcript");
    scrolled(transcript, 900);
    fireEvent.touchStart(transcript);
    scrolled(transcript, 500);
    fireEvent.scroll(transcript);
    expect(view.getByTestId("zone").dataset.collapsed).toBe("no");
  });
});
