// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type PaletteItem, type PaletteSearchContext, type WorkbenchActions } from "../extension-system";
import { CommandPalette } from "./CommandPalette";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { READ_ONLY_REASON } from "../use-host-capabilities";
import type { PaletteCommand } from "../palette-results";

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

describe("command palette levels", () => {
  const actions = () => ({ notify: vi.fn(), focusComposer: vi.fn() }) as unknown as WorkbenchActions;
  const labels = () => [...document.querySelectorAll(".palette-results button > span")].map((row) => row.textContent);

  function themes(chosen: (id: string) => void): PaletteCommand {
    return {
      id: "fixture.theme", label: "Change theme…", group: "Look", extensionId: "fixture", extensionName: "Fixture", run: vi.fn(),
      submenu: {
        title: "Change theme",
        items: () => [
          { id: "light", label: "Light", run: () => chosen("light") },
          { id: "dark", label: "Dark", current: true, run: () => chosen("dark") },
          {
            id: "more", label: "More themes", submenu: {
              title: "More themes", searches: true,
              items: async (query) => [{ id: `solar-${query}`, label: `Solarized ${query}`.trim(), run: () => chosen(`solar${query}`) }],
            },
          },
        ],
      },
    };
  }

  it("drills into a command's level, searches it on its own and runs the row without running the command", () => {
    const chosen = vi.fn();
    const command = themes(chosen);
    const onClose = vi.fn();
    render(<CommandPalette open commands={[command]} extensionCount={1} actions={actions()} onClose={onClose} />);
    const root = screen.getByRole("textbox", { name: "Command" });
    fireEvent.change(root, { target: { value: "theme" } });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(command.run).not.toHaveBeenCalled();
    const field = screen.getByRole("textbox", { name: "Change theme" });
    expect(field).toHaveProperty("value", "");
    expect(labels()).toEqual(["Light", "Dark", "More themes"]);
    expect(screen.getByText("Current")).toBeTruthy();
    fireEvent.change(field, { target: { value: "dar" } });
    expect(labels()).toEqual(["Dark"]);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chosen).toHaveBeenCalledWith("dark");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back with Backspace on an empty field, the back button and the breadcrumb, giving each level its query back", async () => {
    render(<CommandPalette open commands={[themes(vi.fn())]} extensionCount={1} actions={actions()} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Command" }), { target: { value: "theme" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Command" }), { key: "Enter" });
    fireEvent.change(screen.getByRole("textbox", { name: "Change theme" }), { target: { value: "more" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Change theme" }), { key: "Enter" });
    await act(async () => undefined);
    expect(labels()).toEqual(["Solarized"]);
    const crumbs = screen.getByRole("navigation", { name: "Palette levels" });
    expect(crumbs.textContent).toBe("CommandsChange themeMore themes");

    const deepest = screen.getByRole("textbox", { name: "More themes" });
    fireEvent.change(deepest, { target: { value: "x" } });
    fireEvent.keyDown(deepest, { key: "Backspace" });
    expect(screen.getByRole("textbox", { name: "More themes" })).toBeTruthy();
    fireEvent.change(deepest, { target: { value: "" } });
    fireEvent.keyDown(deepest, { key: "Backspace" });
    expect(screen.getByRole("textbox", { name: "Change theme" })).toHaveProperty("value", "more");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Command" })).toHaveProperty("value", "theme");
    expect(screen.queryByRole("navigation", { name: "Palette levels" })).toBeNull();
  });

  it("asks a level that searches itself per keystroke and shows what the latest query answered", async () => {
    render(<CommandPalette open menu="fixture.theme" commands={[themes(vi.fn())]} extensionCount={1} actions={actions()} onClose={() => undefined} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Change theme" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Change theme" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Change theme" }), { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "More themes" });
    fireEvent.change(field, { target: { value: "Dark" } });
    await act(async () => undefined);
    expect(labels()).toEqual(["Solarized Dark"]);
  });

  it("opens on a command's level when asked for it, and says why a level failed", async () => {
    const failing: PaletteCommand = {
      id: "fixture.fails", label: "Broken…", group: "Look", extensionId: "fixture", extensionName: "Fixture", run: vi.fn(),
      submenu: { title: "Broken", items: async () => { throw new Error("The host went away."); } },
    };
    render(<CommandPalette open menu="fixture.fails" commands={[failing]} extensionCount={1} actions={actions()} onClose={() => undefined} />);
    expect(screen.getByRole("textbox", { name: "Broken" })).toBeTruthy();
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toBe("The host went away.");
  });
});

describe("command palette on a Read-only device", () => {
  const entry = (id: string, label: string, group: string, access?: "read" | "write"): PaletteCommand => ({
    id, label, group, extensionId: "fixture", extensionName: "Fixture", run: vi.fn(), ...(access ? { access } : {}),
  });
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".palette-results button")];
  const labels = () => buttons().map((row) => row.querySelector("span")!.textContent);

  function setupReadOnly(commands: PaletteCommand[], registry?: ExtensionRegistry, menu?: string) {
    const actions = { notify: vi.fn(), openSettings: vi.fn(), focusComposer: vi.fn() } as unknown as WorkbenchActions;
    const onClose = vi.fn();
    render(
      <HostClientProvider client={createFakeHostClient({ isReadOnly: () => true })}>
        <CommandPalette open commands={commands} extensionCount={1} actions={actions} registry={registry} menu={menu} onClose={onClose} />
      </HostClientProvider>,
    );
    return { actions, onClose, input: screen.getByRole("textbox") };
  }

  it("shows a write disabled with the reason, keeps the cursor off it and never runs it", () => {
    const next = entry("thread.next", "Next thread", "Thread", "read");
    const pin = entry("thread.pin", "Pin thread", "Thread");
    const { input, onClose } = setupReadOnly([pin, next]);
    expect(labels()).toEqual(["Pin thread", "Next thread"]);
    const [locked, open] = buttons();
    expect(locked!.getAttribute("aria-disabled")).toBe("true");
    expect(locked!.getAttribute("data-tooltip")).toBe(READ_ONLY_REASON);
    expect(locked!.textContent).toContain("Read only");
    expect(open!.className).toBe("selected");

    fireEvent.click(locked!);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(open!.className).toBe("selected");
    expect(pin.run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(next.run).toHaveBeenCalled();
  });

  it("leaves out a group that only writes and a source whose rows all do", () => {
    const registry = new ExtensionRegistry();
    registry.activate({
      id: "fixture.sources",
      name: "Sources",
      activate(context) {
        context.registerPaletteSource({ id: "fixture.projects", label: "Projects", search: () => [{ id: "p", label: "Composer project", run: vi.fn() }] });
        context.registerPaletteSource({ id: "fixture.threads", label: "Threads", search: () => [{ id: "t", label: "Composer thread", access: "read", run: vi.fn() }] });
      },
    });
    const { input } = setupReadOnly([
      entry("composer.mode", "Composer access level", "Composer", "write"),
      entry("composer.effort", "Composer effort", "Composer"),
      entry("workbench.focus-composer", "Focus composer", "Workbench", "read"),
    ], registry);
    fireEvent.change(input, { target: { value: "composer" } });
    // Core's Settings rows only look; the matching command ranks first.
    expect(labels()).toEqual(["Focus composer", "Composer thread", "Composer editing modeDefaults"]);
  });

  it("disables a level's rows that write and does not open on a level whose command writes", () => {
    const chosen = vi.fn();
    const theme = { ...entry("fixture.theme", "Change theme…", "Look", "read"), submenu: { title: "Change theme", items: () => [
      { id: "dark", label: "Dark", access: "read" as const, run: () => chosen("dark") },
      { id: "shared", label: "Save as the host's theme", run: () => chosen("shared") },
    ] } };
    const { input } = setupReadOnly([theme, { ...entry("fixture.model", "Set model…", "Look"), submenu: { title: "Set model", items: () => [] } }], undefined, "fixture.model");
    expect(screen.getByRole("textbox", { name: "Command" })).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(labels()).toEqual(["Dark", "Save as the host's theme"]);
    expect(buttons()[1]!.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(buttons()[1]!);
    expect(chosen).not.toHaveBeenCalled();
    fireEvent.click(buttons()[0]!);
    expect(chosen).toHaveBeenCalledWith("dark");
  });
});

describe("command palette shortcuts", () => {
  it("marks a row's chord as a keyboard hint, which a touch screen leaves out", () => {
    const command: PaletteCommand = { id: "fixture.pin", label: "Pin thread", group: "Thread", extensionId: "fixture", extensionName: "Fixture", run: vi.fn() };
    render(<CommandPalette open commands={[command]} extensionCount={1} actions={{ notify: vi.fn() } as unknown as WorkbenchActions} shortcutFor={() => "⌘⇧P"} onClose={() => undefined} />);
    expect(screen.getByText("⌘⇧P").classList.contains("keyboard-hint")).toBe(true);
  });
});
