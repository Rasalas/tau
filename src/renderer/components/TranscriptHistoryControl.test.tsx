// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptHistoryControl } from "./TranscriptHistoryControl";

describe("TranscriptHistoryControl", () => {
  afterEach(cleanup);

  it("shows an explicit action while older turns are available", () => {
    const onLoad = vi.fn();
    render(<TranscriptHistoryControl olderCursor="20" loading={false} onLoad={onLoad} />);

    expect(screen.getByRole("status").textContent).toContain("Older turns are available.");
    fireEvent.click(screen.getByRole("button", { name: "Load older turns" }));
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("makes loading, retry, and the end of history explicit", () => {
    const onLoad = vi.fn();
    const view = render(<TranscriptHistoryControl olderCursor="20" loading onLoad={onLoad} />);
    expect(screen.getByRole("status").textContent).toContain("Loading older turns…");
    expect((screen.getByRole("button", { name: "Loading older turns" }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<TranscriptHistoryControl olderCursor="20" loading={false} status={{ state: "error", message: "Could not load older turns: offline" }} onLoad={onLoad} />);
    expect(screen.getByRole("status").textContent).toContain("offline");
    expect((screen.getByRole("button", { name: "Retry loading older turns" }) as HTMLButtonElement).disabled).toBe(false);

    view.rerender(<TranscriptHistoryControl loading={false} status={{ state: "success", loadedTurns: 20 }} onLoad={onLoad} />);
    expect(screen.getByRole("status").textContent).toContain("Beginning of history");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
