// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChunkRecovery } from "../chunk-reload";
import { setHostClient } from "../host-client-context";
import { setPlatform } from "../platform-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); setHostClient(undefined); setPlatform(undefined); });

const fault = { broken: true };

function Fragile({ label = "Fine" }: { label?: string }) {
  if (fault.broken) throw new Error("transcript row broke", { cause: new Error("text was an object") });
  return <p>{label}</p>;
}

const recovery = (): ChunkRecovery & { reload: ReturnType<typeof vi.fn<ChunkRecovery["reload"]>> } => ({ reloadOnce: () => false, reloading: () => false, reload: vi.fn() });

describe("RenderErrorBoundary", () => {
  beforeEach(() => { fault.broken = true; });

  it("draws its children until one throws", () => {
    fault.broken = false;
    render(<RenderErrorBoundary scope="window"><Fragile /></RenderErrorBoundary>);
    expect(screen.getByText("Fine")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("covers the window with a plain message and the three ways out", () => {
    render(<RenderErrorBoundary scope="window"><Fragile /></RenderErrorBoundary>);
    const card = screen.getByRole("alert");
    expect(card.textContent).toContain("Something went wrong.");
    expect(card.textContent).toContain("Tau could not draw this window.");
    expect(card.parentElement?.classList.contains("lazy-feature-screen")).toBe(true);
    for (const name of ["Try again", "Reload", "Copy error"]) expect(screen.getByRole("button", { name })).not.toBeNull();
    expect(card.querySelector("details pre")?.textContent).toContain("transcript row broke");
  });

  it("takes the place of the conversation column, which stays the page's main landmark", () => {
    render(<RenderErrorBoundary scope="conversation"><Fragile /></RenderErrorBoundary>);
    const card = screen.getByRole("alert");
    expect(card.parentElement?.matches("main.conversation-column.conversation-failed")).toBe(true);
    expect(card.textContent).toContain("You can still pick another thread.");
  });

  it("draws the children again on Try again", async () => {
    render(<RenderErrorBoundary scope="conversation"><Fragile /></RenderErrorBoundary>);
    // Still broken: the card comes back rather than a blank window.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert")).not.toBeNull();

    fault.broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Fine")).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("reloads the window on Reload", () => {
    const reload = recovery();
    render(<RenderErrorBoundary scope="window" recovery={reload}><Fragile /></RenderErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload.reload).toHaveBeenCalledTimes(1);
  });

  it("clears a failure when the key changes, so another thread opens", async () => {
    const view = render(<RenderErrorBoundary scope="conversation" resetKey="a"><Fragile label="Thread a" /></RenderErrorBoundary>);
    expect(screen.getByRole("alert")).not.toBeNull();
    fault.broken = false;
    // Same key: the card stays until the user acts.
    view.rerender(<RenderErrorBoundary scope="conversation" resetKey="a"><Fragile label="Thread a" /></RenderErrorBoundary>);
    expect(screen.getByRole("alert")).not.toBeNull();
    view.rerender(<RenderErrorBoundary scope="conversation" resetKey="b"><Fragile label="Thread b" /></RenderErrorBoundary>);
    expect(await screen.findByText("Thread b")).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("copies a report with the stack, the cause and the component, and no address", async () => {
    const copyText = vi.fn(async (_text: string) => undefined);
    setHostClient(createFakeHostClient({ copyText }));
    render(<RenderErrorBoundary scope="conversation"><Fragile /></RenderErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Copy error" }));

    expect(await screen.findByRole("button", { name: "Copied" })).not.toBeNull();
    const report = copyText.mock.calls[0]![0];
    expect(report).toContain("Tau render error (conversation)");
    expect(report).toContain("transcript row broke");
    expect(report).toContain("Caused by:");
    expect(report).toContain("text was an object");
    expect(report).toContain("Component stack:");
    expect(report).toContain("Fragile");
    expect(report).not.toContain(window.location.href);
  });

  it("says so when the clipboard refuses", async () => {
    setHostClient(createFakeHostClient({ copyText: async () => { throw new Error("no clipboard"); } }));
    render(<RenderErrorBoundary scope="window"><Fragile /></RenderErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
    expect(await screen.findByRole("button", { name: "Copy failed" })).not.toBeNull();
  });
});
