// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Suspense, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LazyFeatureBoundary, retryableLazy } from "./LazyFeature";
import { createChunkRecovery } from "../chunk-reload";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const chunkError = () => new Error("Failed to fetch dynamically imported module: file:///app/dist/assets/Usage-abc.js");

/** A session's storage and a reload that only counts, for one page load of one build. */
function recovery(storage = new Map<string, string>(), build = "index-1.js") {
  const reload = vi.fn();
  const ports = {
    storage: () => ({ getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }),
    reload,
    build: () => build,
  };
  return { recovery: createChunkRecovery(ports), reload, storage };
}

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

  it("draws the card inside the frame the feature draws itself in", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const frame = (content: ReactNode) => <section className="app-page">{content}</section>;
    const { container } = render(
      <div className="app-shell">
        <LazyFeatureBoundary label="page" title="This page failed to load." frame={frame}>
          <ThrowingComponent message="broken page" />
        </LazyFeatureBoundary>
      </div>,
    );
    const card = screen.getByRole("alert");
    expect(card.parentElement).toBe(container.querySelector(".app-shell > section.app-page"));
    expect(card.textContent).toContain("This page failed to load.");
    expect(card.querySelector("details pre")?.textContent).toBe("broken page");
  });

  it("imports again on Retry instead of keeping the rejected import", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const Feature = retryableLazy(async () => {
      calls += 1;
      if (calls === 1) throw new Error("module broke");
      return { default: () => <p>Loaded</p> };
    });
    render(<LazyFeatureBoundary label="feature"><Suspense fallback={null}><Feature /></Suspense></LazyFeatureBoundary>);
    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(calls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Loaded")).not.toBeNull();
    expect(calls).toBe(2);
  });

  it("reloads once for a missing chunk, and offers Reload window when the reload did not help", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new Map<string, string>();
    const first = recovery(storage);
    const failing = () => retryableLazy<() => null>(() => Promise.reject(chunkError()));
    const Stale = failing();
    const deactivate = vi.fn();
    const view = render(<LazyFeatureBoundary label="usage" extensionId="usage" registry={{ deactivate }} recovery={first.recovery}>
      <Suspense fallback={null}><Stale /></Suspense>
    </LazyFeatureBoundary>);
    await act(async () => {});
    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("Loading the new version");
    // The build went stale; the extension did nothing wrong.
    expect(deactivate).not.toHaveBeenCalled();
    view.unmount();

    // The page after the reload runs the same build, and the chunk is still missing.
    const second = recovery(storage);
    const StillStale = failing();
    render(<LazyFeatureBoundary label="usage" recovery={second.recovery}><Suspense fallback={null}><StillStale /></Suspense></LazyFeatureBoundary>);
    const card = await screen.findByRole("alert");
    expect(second.reload).not.toHaveBeenCalled();
    expect(card.textContent).toContain("Tau was updated. Reload to continue.");
    // The browser would answer a second import of the same chunk with the same failure.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload window" }));
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it("offers Close where the feature covers the window", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onClose = vi.fn();
    render(<LazyFeatureBoundary label="settings" onClose={onClose}><ThrowingComponent message="x" /></LazyFeatureBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
