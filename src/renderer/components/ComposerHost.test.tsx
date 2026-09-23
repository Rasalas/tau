// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveStatus } from "./ComposerHost";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LiveStatus", () => {
  it("says how long the run has worked without naming a runtime", () => {
    vi.useFakeTimers({ now: 10_000 });
    const view = render(<LiveStatus startedAt={7_000} />);
    expect(view.container.textContent).toBe("Working for 3s");
  });

  it("falls back to a plain line without a start time, and shows a kit's label as given", () => {
    const view = render(<LiveStatus />);
    expect(view.container.textContent).toBe("Working…");
    view.rerender(<LiveStatus label="Waiting for workspace…" />);
    expect(view.container.textContent).toBe("Waiting for workspace…");
  });
});
