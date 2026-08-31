// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asHostTranscriptCursor } from "../../shared/transcript-cursor";
import { TranscriptHistoryControl } from "./TranscriptHistoryControl";

describe("TranscriptHistoryControl", () => {
  afterEach(cleanup);

  it("shows an explicit action while older turns are available", () => {
    const onLoad = vi.fn();
    render(<TranscriptHistoryControl olderCursor={asHostTranscriptCursor("opaque:20")} loading={false} onLoad={onLoad} />);

    expect(screen.getByRole("status").textContent).toContain("Older turns are available.");
    fireEvent.click(screen.getByRole("button", { name: "Load older turns" }));
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("makes loading, retry, and the end of history explicit", () => {
    const onLoad = vi.fn();
    const olderCursor = asHostTranscriptCursor("opaque:20");
    const view = render(<TranscriptHistoryControl olderCursor={olderCursor} loading onLoad={onLoad} />);
    expect(screen.getByRole("status").textContent).toContain("Loading older turns…");
    expect((screen.getByRole("button", { name: "Loading older turns" }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<TranscriptHistoryControl olderCursor={olderCursor} loading={false} status={{ state: "error", message: "Could not load older turns: offline" }} onLoad={onLoad} />);
    expect(screen.getByRole("status").textContent).toContain("offline");
    expect((screen.getByRole("button", { name: "Retry loading older turns" }) as HTMLButtonElement).disabled).toBe(false);

    view.rerender(<TranscriptHistoryControl loading={false} status={{ state: "success", loadedTurns: 20 }} onLoad={onLoad} />);
    expect(screen.getByRole("status").textContent).toContain("Beginning of history");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not claim the beginning when a legacy bridge truncated the snapshot", () => {
    render(<TranscriptHistoryControl
      loading={false}
      historyCompleteness="legacy-truncated"
      onLoad={vi.fn()}
    />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Older history cannot be loaded with this Pi bridge");
    expect(status.textContent).toContain("Upgrade");
    expect(status.textContent).not.toContain("Beginning of history");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses neutral language when an older bridge cannot determine availability", () => {
    render(<TranscriptHistoryControl
      loading={false}
      historyCompleteness="unknown"
      onLoad={vi.fn()}
    />);

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("availability cannot be determined");
    expect(text).toContain("may enable");
    expect(text).not.toContain("Beginning of history");
    expect(text).not.toContain("Upgrade the bridge to load it");
  });
});
