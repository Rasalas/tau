// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { domKeybindingContext } from "./keybinding-context";

afterEach(() => { document.body.innerHTML = ""; });

describe("keybinding contexts from the page", () => {
  it("says where the keyboard is and what is drawn", () => {
    document.body.innerHTML = `
      <section data-keybinding-context="stage"><div data-keybinding-context="terminal editor"><textarea id="shell"></textarea></div></section>
      <div data-keybinding-context="preview" hidden></div>
      <input id="elsewhere" />`;
    document.getElementById("shell")!.focus();
    let context = domKeybindingContext();
    expect(context("terminalFocus")).toBe(true);
    expect(context("editorFocus")).toBe(true);
    expect(context("stageFocus")).toBe(true);
    expect(context("previewFocus")).toBe(false);
    expect(context("terminalOpen")).toBe(true);
    expect(context("modelPickerOpen")).toBe(false);
    expect(context("somethingElse")).toBe(false);

    document.getElementById("elsewhere")!.focus();
    context = domKeybindingContext();
    expect(context("terminalFocus")).toBe(false);
    expect(context("stageFocus")).toBe(false);
  });

  it("knows when a text field has the keyboard, without any mark", () => {
    document.body.innerHTML = `
      <input id="field" /><div id="rich" contenteditable="true"><span id="inside">x</span></div>
      <button id="button">Go</button><nav id="rail" tabindex="0"></nav>`;
    const focusedIn = (id: string) => { document.getElementById(id)!.focus(); return domKeybindingContext()("editableFocus"); };
    expect(focusedIn("field")).toBe(true);
    expect(focusedIn("rich")).toBe(true);
    expect(focusedIn("button")).toBe(false);
    expect(focusedIn("rail")).toBe(false);
  });
});
