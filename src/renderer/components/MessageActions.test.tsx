// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { installPointerEvents } from "../test-support/pointer-events";
import { TestProviders } from "../test-support/test-providers";
import { Message } from "./Message";

beforeAll(installPointerEvents);
afterEach(() => { cleanup(); vi.useRealTimers(); delete document.body.dataset.profile; window.getSelection()?.removeAllRanges(); });

const reply: UiMessage = { id: "a1", role: "assistant", text: "First paragraph.\n\nSecond paragraph.", timestamp: 1 };
const question: UiMessage = { id: "u1", role: "user", text: "Why?", timestamp: 1 };

function renderMessages(run = vi.fn()) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.cite", name: "Cite", activate(context) { context.registerMessageAction({ id: "cite", label: "Cite", run }); } });
  const actions = { notify: vi.fn() } as unknown as WorkbenchActions;
  render(
    <WorkbenchShellContext.Provider value={{ registry, actions }}>
      <Message message={question} onCopy={() => {}} />
      <Message message={reply} onCopy={() => {}} />
    </WorkbenchShellContext.Provider>,
  );
  return { run, actions };
}

describe("message actions from extensions", () => {
  it("puts an action on assistant replies only, and hands it the message and the actions", () => {
    const { run, actions } = renderMessages();
    const buttons = screen.getAllByRole("button", { name: "Cite" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(run).toHaveBeenCalledWith(reply, {}, actions);
  });

  it("passes the text selected inside that message, and nothing selected elsewhere", () => {
    const { run } = renderMessages();
    const paragraph = screen.getByText("Second paragraph.");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.addRange(range);
    fireEvent.click(screen.getByRole("button", { name: "Cite" }));
    expect(run).toHaveBeenLastCalledWith(reply, { selection: "Second paragraph." }, expect.anything());

    window.getSelection()!.removeAllRanges();
    const outside = document.createRange();
    outside.selectNodeContents(screen.getByText("Why?"));
    window.getSelection()!.addRange(outside);
    fireEvent.click(screen.getByRole("button", { name: "Cite" }));
    expect(run).toHaveBeenLastCalledWith(reply, {}, expect.anything());
  });

  it("reports a failing action instead of throwing", async () => {
    const { actions } = renderMessages(vi.fn(() => { throw new Error("no composer"); }));
    fireEvent.click(screen.getByRole("button", { name: "Cite" }));
    await vi.waitFor(() => expect(actions.notify).toHaveBeenCalledWith("no composer"));
  });
});


describe("mobile message actions", () => {
  it("ignores a tap, opens a sheet on long press, and runs the same copy action", async () => {
    document.body.dataset.profile = "compact";
    const copy = vi.fn();
    render(<TestProviders><Message message={question} onCopy={copy} /></TestProviders>);
    const text = screen.getByText("Why?");
    fireEvent.click(text);
    expect(text.closest(".message-shell")?.hasAttribute("data-touch-actions")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Message actions" })).toBeNull();
    // Preload the lazy sheet before a fake timer drives the resting touch.
    await import("../touch/ActionSheet");
    vi.useFakeTimers();
    fireEvent.pointerDown(text, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    await act(() => vi.advanceTimersByTimeAsync(500));
    vi.useRealTimers();
    const sheet = await screen.findByRole("dialog", { name: "Message actions" });
    expect(sheet.classList.contains("action-sheet")).toBe(true);
    fireEvent.pointerUp(text, { pointerType: "touch", pointerId: 1 });
    fireEvent.click(text);
    fireEvent.click(within(sheet).getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith(question);
    expect(screen.queryByRole("dialog", { name: "Message actions" })).toBeNull();
  });

  it("includes extension actions in the mobile sheet", async () => {
    document.body.dataset.profile = "compact";
    const { run, actions } = renderMessages();
    fireEvent.contextMenu(screen.getByText("Second paragraph."));
    const sheet = await screen.findByRole("dialog", { name: "Message actions" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cite" }));
    expect(run).toHaveBeenCalledWith(reply, {}, actions);
  });

  it("cancels a long press when the finger scrolls or the gesture is cancelled", async () => {
    document.body.dataset.profile = "compact";
    render(<Message message={question} onCopy={() => {}} />);
    const text = screen.getByText("Why?");
    vi.useFakeTimers();
    fireEvent.pointerDown(text, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(text, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 50 });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerDown(text, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerCancel(text, { pointerType: "touch", pointerId: 1 });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
