// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, SubmissionResult } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
  activeTools: [], allTools: [], extensionCount: 0, supportsImageInput: false,
};

// jsdom has no PointerEvent; a MouseEvent with the pointer's fields stands in, so a move has its coordinates.
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
    this.pointerId = init.pointerId ?? 0;
  }
}

const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  document.body.dataset.profile = "compact";
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (width) Object.defineProperty(window, "innerWidth", width);
  delete document.body.dataset.profile;
});

function renderPhone({ streaming = false } = {}) {
  const registry = new ExtensionRegistry();
  const onSubmit = vi.fn(async (): Promise<SubmissionResult> => ({ accepted: true }));
  const shot = { ...snapshot, isStreaming: streaming };
  render(
    <TestProviders>
      <WorkbenchShellContext.Provider value={{ registry, snapshot: shot }}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={shot}
          draftStorageKey="session:session"
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={onSubmit}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
        />
      </WorkbenchShellContext.Provider>
    </TestProviders>,
  );
  return { onSubmit, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

async function hold(button: HTMLElement) {
  // The sheets load lazily; a fake clock drives only the resting finger.
  await Promise.all([import("./ComposerSendChooser"), import("./PlanSheet")]);
  vi.useFakeTimers();
  fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
  await act(() => vi.advanceTimersByTimeAsync(499));
}

describe("the phone's send button", () => {
  it("shows send only for a draft, and Stop alone while a turn runs", async () => {
    const { textarea } = renderPhone({ streaming: true });
    expect(screen.getByRole("button", { name: "Stop the run" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Steer this turn" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue or plan" })).toBeNull();
    fireEvent.change(textarea, { target: { value: "turn left" } });
    expect(await screen.findByRole("button", { name: "Steer this turn" })).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Steer this turn" })).toBeNull());
  });

  it("keeps the keyboard's field focused while held, then opens the send options and skips the release", async () => {
    const { onSubmit, textarea } = renderPhone({ streaming: true });
    fireEvent.change(textarea, { target: { value: "and then the docs" } });
    textarea.focus();
    const send = await screen.findByRole("button", { name: "Steer this turn" });
    await hold(send);
    expect(screen.queryByRole("dialog", { name: "Send options" })).toBeNull();
    expect(document.activeElement).toBe(textarea);
    await act(() => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    const sheet = await screen.findByRole("dialog", { name: "Send options" });
    expect(sheet.classList.contains("touch-sheet")).toBe(true);
    expect(within(sheet).getAllByRole("menuitem").map((row) => row.querySelector("em")?.textContent)).toEqual(["Steer this turn", "Queue after this turn", "Plan…"]);
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("menuitem", { name: /Steer this turn/u })));
    // The finger lifts: no tap, and the sheet stays.
    fireEvent.pointerUp(send, { pointerType: "touch", pointerId: 1 });
    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("menuitem", { name: /Queue after this turn/u }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2 as never]).toBe("followUp");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send options" })).toBeNull());
    // The keyboard stays down: focus does not go back to the field.
    expect(document.activeElement).not.toBe(textarea);
  });

  it("plans from the held menu in a sheet", async () => {
    const { onSubmit, textarea } = renderPhone();
    fireEvent.change(textarea, { target: { value: "check the build tomorrow" } });
    await hold(await screen.findByRole("button", { name: "Send" }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    const menu = await screen.findByRole("dialog", { name: "Send options" });
    expect(within(menu).getAllByRole("menuitem").map((row) => row.querySelector("em")?.textContent)).toEqual(["Send now", "Plan…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Plan…/u }));
    const sheet = await screen.findByRole("dialog", { name: "Plan message" });
    expect(sheet.classList.contains("touch-sheet")).toBe(true);
    expect(within(sheet).getByText("check the build tomorrow")).toBeTruthy();
    fireEvent.click(await within(sheet).findByRole("option", { name: /Tomorrow morning/u }));
    const plan = await within(sheet).findByRole("button", { name: /^Plan · / });
    fireEvent.click(plan);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    expect(onSubmit.mock.calls[0]?.[2 as never]).toEqual({ deliverAt: tomorrow.getTime() });
  });

  it("sends on a tap, and a finger that moves away is no hold", async () => {
    const { onSubmit, textarea } = renderPhone();
    fireEvent.change(textarea, { target: { value: "go" } });
    const send = await screen.findByRole("button", { name: "Send" });
    await hold(send);
    fireEvent.pointerMove(send, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 40 });
    await act(() => vi.advanceTimersByTimeAsync(500));
    vi.useRealTimers();
    expect(screen.queryByRole("dialog", { name: "Send options" })).toBeNull();
    fireEvent.pointerUp(send, { pointerType: "touch", pointerId: 1 });
    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Send options" })).toBeNull();
  });
});
