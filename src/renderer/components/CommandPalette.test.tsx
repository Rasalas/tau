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
        search: (query, context: PaletteSearchContext) => {
          signals.push(context.signal);
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
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opened).toHaveBeenCalledWith(actions);

    cleanup();
    const second = setup();
    fireEvent.change(second.input, { target: { value: "spend" } });
    fireEvent.click(screen.getByText("Usage"));
    expect(second.actions.openSettings).toHaveBeenCalledWith("usage");
  });
});
