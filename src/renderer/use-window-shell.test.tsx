// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowAction, WindowShellEvent, WindowShellStatus } from "../shared/window-shell";
import { ThreadStore } from "../workbench/thread-store";
import { ToastStore } from "../workbench/toast-store";
import { PreferencesStore } from "./preferences";
import { takePasteAsText } from "./paste-as-text";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { RELEASE_NOTES_TOAST_MS, useWindowShell, type WindowShellOptions } from "./use-window-shell";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(status: WindowShellStatus = {}) {
  const actions: WindowAction[] = [];
  const client = createFakeHostClient({
    windowAction: async (action) => {
      actions.push(action);
      return action.kind === "status" ? status : undefined;
    },
  });
  const threadStore = new ThreadStore();
  const preferences = new PreferencesStore();
  const toasts = new ToastStore();
  const options: WindowShellOptions = {
    client, threadStore, preferences, toasts,
    openSettings: vi.fn(), openExternal: vi.fn(), setUpdateReady: vi.fn(),
  };
  let handle: (event: WindowShellEvent) => void = () => undefined;
  function Harness() {
    const shell = useWindowShell(options);
    handle = shell.handle;
    return <>{shell.ui}</>;
  }
  render(<Harness />);
  const send = (event: WindowShellEvent) => act(() => handle(event));
  const answers = () => actions.filter((action) => action.kind === "answer-quit").map((action) => action.kind === "answer-quit" ? action.answer : "");
  return { actions, answers, send, threadStore, preferences, toasts, options };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("the app around the workbench", () => {
  it("lets a quit go ahead at once when no thread is working", async () => {
    const { send, answers } = setup();
    send({ kind: "quit-requested", requestId: "quit-1" });
    await flush();
    expect(answers()).toEqual(["quit"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before a quit stops working threads, and can stop asking", async () => {
    const { send, answers, threadStore, preferences } = setup();
    threadStore.setThreadRunning("a", true);
    threadStore.setThreadRunning("b", true);
    send({ kind: "quit-requested", requestId: "quit-1" });
    await flush();
    expect(answers()).toEqual(["asking"]);
    expect(screen.getByText("2 threads are still working. Quitting stops them.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(answers()).toEqual(["asking", "stay"]);

    send({ kind: "quit-requested", requestId: "quit-2" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Quit" }));
    await flush();
    expect(answers()).toEqual(["asking", "stay", "asking", "quit"]);
    expect(preferences.getSnapshot().confirmQuitWhileRunning).toBe(false);

    send({ kind: "quit-requested", requestId: "quit-3" });
    await flush();
    expect(answers().at(-1)).toBe("quit");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("carries out the menu items only the page knows how to", async () => {
    const { send, options, actions } = setup();
    send({ kind: "menu", action: "open-settings" });
    send({ kind: "menu", action: "open-about" });
    expect(vi.mocked(options.openSettings).mock.calls).toEqual([["general"], ["about"]]);
    send({ kind: "menu", action: "paste-as-text" });
    await flush();
    expect(actions).toContainEqual({ kind: "paste-as-text" });
    expect(takePasteAsText()).toBe(true);
  });

  it("arms Paste as Text from its chord", () => {
    setup();
    const mac = /mac/iu.test(navigator.platform);
    fireEvent.keyDown(window, { key: "V", shiftKey: true, metaKey: mac, ctrlKey: !mac });
    expect(takePasteAsText()).toBe(true);
  });

  it("shows the quit shortcut's hint, and keeps a released hold's hint a moment longer", () => {
    vi.useFakeTimers();
    const { send } = setup();
    send({ kind: "quit-shortcut", state: "down", mode: "hold" });
    expect(screen.getByRole("status").textContent).toMatch(/^Hold (⌘Q|Ctrl\+Q) or press it twice to quit$/u);
    send({ kind: "quit-shortcut", state: "up" });
    expect(screen.queryByRole("status")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_200); });
    expect(screen.queryByRole("status")).toBeNull();
    send({ kind: "quit-shortcut", state: "down", mode: "double-press" });
    expect(screen.getByRole("status").textContent).toMatch(/again to quit$/u);
    send({ kind: "quit-shortcut", state: "up" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers a downloaded update and the new version's notes once the page loads", async () => {
    const { toasts, options, actions } = setup({
      updateReady: "0.6.0",
      releaseNotes: { version: "0.5.0", items: ["Zoom from the View menu", "Paste as Text"], totalItems: 3, url: "https://github.com/o/r/releases/tag/v0.5.0" },
    });
    await flush();
    expect(options.setUpdateReady).toHaveBeenCalledWith("0.6.0");
    const toast = toasts.getToasts().find((entry) => entry.id === "tau.release-notes")!;
    expect(toast.title).toBe("Tau 0.5.0 is installed");
    act(() => { toast.actions![0]!.run(); toasts.dismiss(toast.id); });
    await flush();
    expect(actions).toContainEqual({ kind: "release-notes-seen", version: "0.5.0" });
    expect(screen.getByRole("dialog", { name: "What’s new in Tau 0.5.0" })).toBeTruthy();
    expect(screen.getByText("Paste as Text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /1 more change on GitHub/u }));
    expect(options.openExternal).toHaveBeenCalledWith("https://github.com/o/r/releases/tag/v0.5.0");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets the installed notice go after a while, or at the next click elsewhere", async () => {
    const { toasts, actions } = setup({ releaseNotes: { version: "0.7.4", items: ["Terminal tabs"], totalItems: 1 } });
    await flush();
    const toast = () => toasts.getToasts().find((entry) => entry.id === "tau.release-notes");
    expect(toast()?.timeoutMs).toBe(RELEASE_NOTES_TOAST_MS);
    expect(RELEASE_NOTES_TOAST_MS).toBeGreaterThan(0);

    // A click on the stack itself (its action, its ×) is the toast's own business.
    const stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.append(stack);
    fireEvent.pointerDown(stack);
    expect(toast()).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(toast()).toBeUndefined();
    await flush();
    expect(actions).toContainEqual({ kind: "release-notes-seen", version: "0.7.4" });
    stack.remove();
  });
});
