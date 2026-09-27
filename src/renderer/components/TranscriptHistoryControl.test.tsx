// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asHostTranscriptCursor } from "../../shared/transcript-cursor";
import { TranscriptHistoryControl } from "./TranscriptHistoryControl";

const olderCursor = asHostTranscriptCursor("opaque:20");
const state = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-older-turns]")?.dataset.olderTurns;

describe("TranscriptHistoryControl", () => {
  afterEach(cleanup);

  it("shows nothing while older turns wait for the reader to scroll up", () => {
    const view = render(<TranscriptHistoryControl olderCursor={olderCursor} loading={false} onRetry={vi.fn()} />);

    expect(state(view.container)).toBe("available");
    expect(view.container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a quiet line while a page loads, then Retry in its place after a failure", () => {
    const onRetry = vi.fn();
    const view = render(<TranscriptHistoryControl olderCursor={olderCursor} loading onRetry={onRetry} />);
    expect(state(view.container)).toBe("loading");
    expect(screen.getByRole("status").textContent).toBe("Loading older turns…");
    expect(screen.queryByRole("button")).toBeNull();

    view.rerender(<TranscriptHistoryControl olderCursor={olderCursor} loading={false} status={{ state: "error", message: "Could not load older turns: offline" }} onRetry={onRetry} />);
    expect(state(view.container)).toBe("error");
    expect(screen.getByRole("status").textContent).toContain("offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading older turns" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders nothing at the thread's real start", () => {
    const view = render(<TranscriptHistoryControl loading={false} status={{ state: "success", loadedTurns: 20 }} onRetry={vi.fn()} />);
    expect(view.container.innerHTML).toBe("");
  });

  it("renders nothing when history availability is unknown", () => {
    const view = render(<TranscriptHistoryControl
      olderCursor={olderCursor}
      loading={false}
      historyCompleteness="unknown"
      status={{ state: "success", loadedTurns: 20 }}
      onRetry={vi.fn()}
    />);
    expect(view.container.innerHTML).toBe("");
  });

  it("takes no height in the transcript, so its line never moves the rows", async () => {
    const css = await readFile(resolve(__dirname, "../styles.css"), "utf8");
    const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/\./gu, "\\.")} \\{([^}]*)\\}`, "u"))?.[1] ?? "";

    expect(rule(".transcript-history")).toMatch(/height: 0;/u);
    expect(rule(".transcript-history-row")).toMatch(/position: absolute;/u);
  });
});
