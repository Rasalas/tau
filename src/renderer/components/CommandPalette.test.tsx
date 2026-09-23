// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type PaletteItem, type PaletteSearchContext, type WorkbenchActions } from "../extension-system";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const registry = new ExtensionRegistry();
  const actions = { openSettings: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions;
  const pending = new Map<string, ReturnType<typeof deferred<PaletteItem[]>>>();
  const signals: AbortSignal[] = [];
  const opened = vi.fn();
  registry.activate({
    id: "fixture.search",
    name: "Search fixture",
    activate(context) {
      context.registerPaletteSource({
        id: "fixture.projects",
        label: "Projects",
        order: 10,
        search: (query) => query.startsWith("al") ? [{ id: "alpha", label: "Alpha project", detail: "~/alpha", run: opened }] : [],
      });
      context.registerPaletteSource({
        id: "fixture.content",
        label: "In threads",
        order: 20,
        search: (query, search: PaletteSearchContext) => {
          signals.push(search.signal);
          const answer = deferred<PaletteItem[]>();
          pending.set(query, answer);
          return answer.promise;
        },
      });
      context.registerSettingsPage({ id: "usage", label: "Usage", keywords: ["alpaca spend"], profiles: ["desktop"], Component: () => null });
    },
  });
  render(<CommandPalette open commands={[]} extensionCount={1} actions={actions} registry={registry} onClose={() => undefined} />);
  const input = screen.getByRole("textbox", { name: "Command" });
  const rows = () => [...document.querySelectorAll(".palette-results button")].map((row) => row.textContent);
  return { actions, input, pending, signals, rows, opened };
}

describe("command palette sources", () => {
  it("shows a source's rows as they arrive, in source order, with core's Settings rows after them", async () => {
    const { input, pending, rows } = setup();
    fireEvent.change(input, { target: { value: "alp" } });
    expect(rows()).toEqual(["Alpha project~/alphaprojects", "UsageSettingssettings"]);
    await act(async () => { pending.get("alp")!.resolve([{ id: "t1", label: "Fix alpaca import", detail: "tau", run: () => undefined }]); });
    expect(rows()).toEqual(["Alpha project~/alphaprojects", "Fix alpaca importtauin threads", "UsageSettingssettings"]);
  });

  it("drops an answer that belongs to an earlier query and aborts its signal", async () => {
    const { input, pending, signals, rows } = setup();
    fireEvent.change(input, { target: { value: "alp" } });
    fireEvent.change(input, { target: { value: "alph" } });
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => { pending.get("alp")!.resolve([{ id: "late", label: "Late answer", run: () => undefined }]); });
    expect(rows().some((row) => row?.includes("Late answer"))).toBe(false);
  });

  it("runs the row Enter lands on and opens a Settings page from core's own rows", async () => {
    const { actions, input, opened } = setup();
    fireEvent.change(input, { target: { value: "alp" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(opened).toHaveBeenCalledWith(actions);

    cleanup();
    const second = setup();
    fireEvent.change(second.input, { target: { value: "spend" } });
    fireEvent.click(screen.getByText("Usage"));
    expect(second.actions.openSettings).toHaveBeenCalledWith("usage");
  });
});

describe("command palette focus", () => {
  function Toggle({ open, focusComposer }: { open: boolean; focusComposer(): void }) {
    const actions = { notify: vi.fn(), focusComposer } as unknown as WorkbenchActions;
    return <CommandPalette open={open} commands={[]} extensionCount={0} actions={actions} onClose={() => undefined} />;
  }

  it("gives focus back to what had it when it opened", () => {
    const trigger = document.body.appendChild(document.createElement("textarea"));
    trigger.focus();
    const focusComposer = vi.fn();
    const view = render(<Toggle open focusComposer={focusComposer} />);
    act(() => { screen.getByRole("textbox", { name: "Command" }).focus(); });
    view.rerender(<Toggle open={false} focusComposer={focusComposer} />);
    expect(document.activeElement).toBe(trigger);
    expect(focusComposer).not.toHaveBeenCalled();
    trigger.remove();
  });

  it("gives it to the composer when nothing had it, as T3 Code does", () => {
    const focusComposer = vi.fn();
    const view = render(<Toggle open focusComposer={focusComposer} />);
    act(() => { screen.getByRole("textbox", { name: "Command" }).focus(); });
    view.rerender(<Toggle open={false} focusComposer={focusComposer} />);
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside itself and closes on Escape from wherever focus is in it", () => {
    const onClose = vi.fn();
    const actions = { notify: vi.fn(), focusComposer: vi.fn() } as unknown as WorkbenchActions;
    render(<CommandPalette open commands={[]} extensionCount={0} actions={actions} onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Command" });
    act(() => { input.focus(); });
    // jsdom lays out no rows, so the field is the only stop and Tab stays on it.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }).querySelector("footer")!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
