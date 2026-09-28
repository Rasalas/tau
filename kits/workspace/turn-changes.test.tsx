// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningTurn } from "../../src/renderer/test-support/kit-harness.js";
import { installPointerEvents } from "../../src/renderer/test-support/pointer-events.js";
import { countFiles, TURN_CHANGES_CLOSE_DELAY_MS, TURN_CHANGES_OPEN_DELAY_MS, TurnChangesPill } from "./turn-changes.js";

installPointerEvents();
afterEach(() => { cleanup(); vi.useRealTimers(); });

const changes = {
  files: [
    { path: "notes.txt", name: "notes.txt", directory: "", status: "added" as const, added: 3, removed: 0 },
    { path: "src/README.md", name: "README.md", directory: "src", status: "modified" as const, added: 1, removed: 2 },
  ],
  added: 4,
  removed: 2,
};

const pill = () => screen.getByRole("button", { name: /^Turn changes:/u });

describe("TurnChangesPill", () => {
  it("sums the turn up in one line", () => {
    render(<TurnChangesPill changes={changes} onOpenDiff={vi.fn()} />);

    expect(pill().textContent).toBe("2 files+4−2");
    expect(pill().getAttribute("aria-label")).toBe("Turn changes: 2 files, 4 lines added, 2 removed");
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    expect(countFiles(1)).toBe("1 file");
  });

  it("wears the row's shared pill look over the composer, and its own small one in the transcript", () => {
    const view = render(<TurnChangesPill changes={changes} onOpenDiff={vi.fn()} />);
    expect(pill().classList.contains("control-pill")).toBe(true);
    view.rerender(<TurnChangesPill changes={changes} onOpenDiff={vi.fn()} side="bottom" />);
    expect(pill().classList.contains("control-pill")).toBe(false);
  });

  it("draws nothing for a turn that changed no files, even one that could be rewound", () => {
    const view = render(<TurnChangesPill changes={{ files: [], fileCount: 0, added: 0, removed: 0 }} onOpenDiff={vi.fn()} onRestore={vi.fn()} />);
    expect(view.container.innerHTML).toBe("");
  });

  it("opens the detail on click; a file opens its diff and closes it", async () => {
    const onOpenDiff = vi.fn();
    render(<TurnChangesPill changes={changes} onOpenDiff={onOpenDiff} />);

    fireEvent.click(pill());
    const detail = await screen.findByRole("dialog", { name: "Turn changes" });
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    expect(detail.textContent).toContain("src/README.md");

    fireEvent.click(screen.getByText("src/README.md"));
    expect(onOpenDiff).toHaveBeenCalledWith("src/README.md");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a clicked detail open until Escape, and offers Open diff and Rewind", async () => {
    const onOpenDiff = vi.fn();
    const onRestore = vi.fn();
    render(<TurnChangesPill changes={changes} onOpenDiff={onOpenDiff} onRestore={onRestore} />);

    fireEvent.click(pill());
    fireEvent.click(await screen.findByRole("button", { name: "Open diff" }));
    expect(onOpenDiff).toHaveBeenCalledWith(undefined);

    fireEvent.click(pill());
    fireEvent.click(await screen.findByRole("button", { name: "Rewind" }));
    expect(onRestore).toHaveBeenCalledOnce();

    fireEvent.click(pill());
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens on a resting mouse and closes after the mouse leaves; a touch opens nothing", async () => {
    render(<TurnChangesPill changes={changes} onOpenDiff={vi.fn()} />);
    // Load the lazy popover once, so the fake clock below only drives the hover.
    fireEvent.click(pill());
    await screen.findByRole("dialog");
    fireEvent.click(pill());
    expect(screen.queryByRole("dialog")).toBeNull();

    vi.useFakeTimers();
    fireEvent.pointerOver(pill(), { pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(TURN_CHANGES_OPEN_DELAY_MS); });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.pointerOver(pill(), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(TURN_CHANGES_OPEN_DELAY_MS - 1); });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Crossing from the pill into its detail keeps it open.
    fireEvent.pointerOut(pill(), { pointerType: "mouse", relatedTarget: screen.getByRole("dialog").firstElementChild });
    fireEvent.pointerOver(screen.getByRole("dialog").firstElementChild!, { pointerType: "mouse", relatedTarget: pill() });
    act(() => { vi.advanceTimersByTime(TURN_CHANGES_CLOSE_DELAY_MS); });
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.pointerOut(screen.getByRole("dialog").firstElementChild!, { pointerType: "mouse", relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(TURN_CHANGES_CLOSE_DELAY_MS); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves the keyboard into the detail it opened, and back to the pill on Escape", async () => {
    render(<TurnChangesPill changes={changes} onOpenDiff={vi.fn()} />);
    pill().focus();
    fireEvent.click(pill(), { detail: 0 });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open diff"));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(pill());
  });

  it("closes on Escape during a running turn, with focus in the detail or in the composer, and stops nothing", async () => {
    const { abort } = runningTurn();
    render(<main data-keybinding-context="chat"><textarea aria-label="Composer" /><TurnChangesPill live changes={changes} onOpenDiff={vi.fn()} /></main>);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    const live = screen.getByRole("button", { name: /^Changes so far:/u });

    live.focus();
    fireEvent.click(live, { detail: 0 });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open diff"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(live);
    await screen.findByRole("dialog");
    composer.focus();
    fireEvent.keyDown(composer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(abort).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: "Escape" });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("marks a partial capture and says what it may have missed", async () => {
    render(<TurnChangesPill
      changes={{ files: [], fileCount: 0, added: 0, removed: 0, completeness: "partial", incompleteReason: "Snapshot coverage is partial: file-count limit.", omittedFileCount: 4 }}
      onOpenDiff={vi.fn()}
    />);

    expect(pill().textContent).toContain("0+ files");
    fireEvent.click(pill());
    expect(await screen.findByText(/file-count limit/u)).toBeTruthy();
    expect(screen.getByText(/4 files omitted/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open diff" })).toBeNull();
  });

  it("names the running turn's changes as what it changed so far", () => {
    render(<TurnChangesPill live changes={changes} onOpenDiff={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Changes so far: 2 files/u })).toBeTruthy();
  });
});
