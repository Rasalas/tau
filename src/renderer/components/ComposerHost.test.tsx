// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveStatus } from "./ComposerHost";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LiveStatus", () => {
  it("says Thinking with the run's clock, naming no runtime", () => {
    vi.useFakeTimers({ now: 10_000 });
    const view = render(<LiveStatus startedAt={7_000} />);
    expect(view.container.textContent).toBe("Thinking0:03");
    expect(view.container.querySelector(".work-live.thinking .work-shine svg")).toBeTruthy();
  });

  it("drops the clock without a start time, and shows a kit's label as given", () => {
    const view = render(<LiveStatus />);
    expect(view.container.textContent).toBe("Thinking");
    view.rerender(<LiveStatus label="Waiting for workspace…" />);
    expect(view.container.textContent).toBe("Waiting for workspace…");
  });
});
