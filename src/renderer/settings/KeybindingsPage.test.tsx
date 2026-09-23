// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type UserKeybinding } from "../extension-system";
import { TestProviders } from "../test-support/test-providers";
import { KeybindingsPage } from "./KeybindingsPage";

afterEach(cleanup);

// jsdom's navigator.platform is empty, so `mod` is Ctrl here.
const ctrl = (key: string, init: KeyboardEventInit = {}) => ({ key, code: /^[a-z]$/u.test(key) ? `Key${key.toUpperCase()}` : "", ctrlKey: true, ...init });

function Page({ registry, onNotify }: { registry: ExtensionRegistry; onNotify?(message: string): void }) {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  return <KeybindingsPage registry={registry} onNotify={onNotify} />;
}

/** Core's chords for three commands, and a keymap that binds what it is given the way Keybindings Kit does. */
function setup({ keymap = true, fail = false } = {}) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "core", name: "Core", activate(context) {
    context.registerCommand({ id: "palette", label: "Command palette", group: "Core", run() {} });
    context.registerCommand({ id: "new-thread", label: "New thread", group: "Core", run() {} });
    context.registerCommand({ id: "split", label: "Split terminal", group: "Terminal", run() {} });
    context.registerKeybinding({ keys: "mod+k", commandId: "palette" });
    context.registerKeybinding({ keys: "mod+n", commandId: "new-thread", when: "!terminalFocus" });
    context.registerKeybinding({ keys: "mod+d", commandId: "split", when: "terminalFocus" });
  } });
  const file: Record<string, UserKeybinding[]> = {};
  const setChords = vi.fn(async (commandId: string, chords: readonly UserKeybinding[] | undefined) => {
    if (fail) throw new Error("disk full");
    if (chords) file[commandId] = [...chords];
    else delete file[commandId];
    rebind();
  });
  const resetAll = vi.fn(async () => { for (const id of Object.keys(file)) delete file[id]; rebind(); });
  let bound: Array<() => void> = [];
  let rebind = () => {};
  if (keymap) {
    registry.activate({ id: "file", name: "Keybindings", activate(context) {
      rebind = () => {
        bound.forEach((dispose) => dispose());
        bound = Object.entries(file).flatMap(([commandId, chords]) => chords.map((chord) => context.registerKeybinding({ keys: chord.key, commandId, replaces: commandId, ...(chord.when ? { when: chord.when } : {}) })));
      };
      context.registerUserKeymap({ id: "file", label: "~/.pi/agent/keybindings.json", setChords, resetAll });
    } });
  }
  const notify = vi.fn();
  render(<TestProviders><Page registry={registry} onNotify={notify} /></TestProviders>);
  return { registry, setChords, resetAll, notify };
}

const chordButton = (name: RegExp) => screen.getByRole("button", { name });
const recorder = () => screen.getByRole("textbox", { name: /Press the new chord/u });

describe("Settings → Keybindings as an editor", () => {
  it("records a chord for a command and writes it, keeping the default's clause", async () => {
    const { setChords, registry } = setup();
    fireEvent.click(chordButton(/Change the chord for New thread: Ctrl\+N/u));
    const field = recorder();
    expect(document.activeElement).toBe(field);
    expect(field.hasAttribute("data-keybinding-capture")).toBe(true);
    // A modifier alone records nothing yet.
    fireEvent.keyDown(field, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(recorder()).toBe(field);
    fireEvent.keyDown(field, ctrl("t"));
    expect(chordButton(/Change the chord for New thread: Ctrl\+T/u)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "When clause for New thread" }) as HTMLInputElement).value).toBe("!terminalFocus");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(setChords).toHaveBeenCalledWith("new-thread", [{ key: "mod+t" }]);
    expect(registry.getKeybindings().find((binding) => binding.commandId === "new-thread")).toMatchObject({ keys: "mod+t", when: "!terminalFocus" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("gives up on Escape and leaves the file alone", () => {
    const { setChords } = setup();
    fireEvent.click(chordButton(/Change the chord for Command palette/u));
    fireEvent.keyDown(recorder(), { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("textbox", { name: /Press the new chord/u })).toBeNull();
    expect(chordButton(/Change the chord for Command palette: Ctrl\+K/u)).toBeTruthy();
    expect(setChords).not.toHaveBeenCalled();
  });

  it("names the chords a recorded one would share keys with, by where they apply", () => {
    setup();
    fireEvent.click(chordButton(/Change the chord for New thread/u));
    fireEvent.keyDown(recorder(), ctrl("k"));
    expect(screen.getByText(/Ctrl\+K: Takes the keys from Command palette \(Core\) wherever both apply\./u)).toBeTruthy();
    // mod+d splits only inside a terminal, where new-thread's own clause cannot hold.
    fireEvent.click(chordButton(/Change the chord for New thread: Ctrl\+K/u));
    fireEvent.keyDown(recorder(), ctrl("d"));
    expect(screen.queryByText(/from Split terminal/u)).toBeNull();
    const when = screen.getByRole("combobox", { name: "When clause for New thread" });
    fireEvent.change(when, { target: { value: "" } });
    expect(screen.getByText(/Ctrl\+D: Takes the keys from Split terminal/u)).toBeTruthy();
  });

  it("checks the when clause before it writes one", async () => {
    const { setChords } = setup();
    fireEvent.click(screen.getByRole("button", { name: "More for Split terminal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Change where it applies" }));
    const when = screen.getByRole("combobox", { name: "When clause for Split terminal" });
    expect(document.activeElement).toBe(when);
    fireEvent.change(when, { target: { value: "terminalFocus &&" } });
    expect(screen.getByRole("alert").textContent).toMatch(/context names/u);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(when, { target: { value: "terminalFocus && !stageFocus" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(setChords).toHaveBeenCalledWith("split", [{ key: "mod+d", when: "terminalFocus && !stageFocus" }]);
  });

  it("resets one command, then every command after asking", async () => {
    const { setChords, resetAll, registry } = setup();
    fireEvent.click(chordButton(/Change the chord for Command palette/u));
    fireEvent.keyDown(recorder(), ctrl("j"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    fireEvent.click(screen.getByRole("button", { name: "More for Command palette" }));
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Reset to default" })); });
    expect(setChords).toHaveBeenLastCalledWith("palette", undefined);
    expect(registry.getKeybindings().find((binding) => binding.commandId === "palette")?.keys).toBe("mod+k");

    fireEvent.click(chordButton(/Change the chord for Command palette/u));
    fireEvent.keyDown(recorder(), ctrl("j"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    const confirm = screen.getByRole("alertdialog", { name: "Reset all keybindings" });
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "Reset all" })); });
    expect(resetAll).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
  });

  it("adds another chord and removes one of several", async () => {
    const { setChords } = setup();
    fireEvent.click(screen.getByRole("button", { name: "More for New thread" }));
    expect(screen.queryByRole("menuitem", { name: "Remove this chord" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add another chord" }));
    fireEvent.keyDown(recorder(), ctrl("t"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(setChords).toHaveBeenLastCalledWith("new-thread", [{ key: "mod+n" }, { key: "mod+t" }]);
    fireEvent.click(screen.getAllByRole("button", { name: "More for New thread" })[0]!);
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Remove this chord" })); });
    expect(setChords).toHaveBeenLastCalledWith("new-thread", [{ key: "mod+t" }]);
  });

  it("finds chords by the keys pressed", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Search by keys" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Press the keys to search for" }), ctrl("k"));
    expect(screen.getByRole("heading", { name: "Active keybindings (1)" })).toBeTruthy();
    expect(chordButton(/Change the chord for Command palette/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear the key search" }));
    expect(screen.getByRole("heading", { name: "Active keybindings (3)" })).toBeTruthy();
  });

  it("says so when the write fails and keeps the draft", async () => {
    const { notify } = setup({ fail: true });
    fireEvent.click(chordButton(/Change the chord for Command palette/u));
    fireEvent.keyDown(recorder(), ctrl("j"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(notify).toHaveBeenCalledWith("Could not write ~/.pi/agent/keybindings.json: disk full");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("only lists while no extension offers a keymap", () => {
    setup({ keymap: false });
    expect(screen.queryByRole("button", { name: /Change the chord/u })).toBeNull();
    expect(screen.getByText("Ctrl+K")).toBeTruthy();
  });
});
