// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LazyFeatureBoundary } from "./LazyFeature";

function ThrowingComponent({ message }: { message: string }): null {
  throw new Error(message);
}

describe("LazyFeatureBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <LazyFeatureBoundary label="test">
        <div>Hello World</div>
      </LazyFeatureBoundary>,
    );
    expect(screen.getByText("Hello World")).not.toBeNull();
  });

  it("catches render errors and renders fallback", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <LazyFeatureBoundary label="my-panel">
        <ThrowingComponent message="explosion" />
      </LazyFeatureBoundary>,
    );
    expect(screen.getByText("Could not load my-panel.")).not.toBeNull();
    consoleError.mockRestore();
  });

  it("deactivates extension in registry and notifies when crash occurs", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const deactivate = vi.fn();
    const onNotify = vi.fn();
    const onError = vi.fn();

    render(
      <LazyFeatureBoundary
        label="flaky"
        extensionId="flaky.ext"
        extensionName="Flaky Extension"
        registry={{ deactivate }}
        onNotify={onNotify}
        onError={onError}
      >
        <ThrowingComponent message="render crash" />
      </LazyFeatureBoundary>,
    );

    expect(deactivate).toHaveBeenCalledWith("flaky.ext");
    expect(onNotify).toHaveBeenCalledWith("Extension Flaky Extension was deactivated due to render error: render crash");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    consoleError.mockRestore();
  });
});
