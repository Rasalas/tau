// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { Message } from "./Message";

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

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
