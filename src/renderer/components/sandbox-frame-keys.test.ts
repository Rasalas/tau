// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type DesktopExtensionContext } from "../extension-system";
import { frameChords, replayableKey } from "./sandbox-frame-keys";

function registryWith(setup: (context: DesktopExtensionContext) => void) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test", name: "Test", activate: setup });
  return registry;
}

const command = (id: string, access?: "read" | "write") => ({ id, label: id, group: "Test", ...(access ? { access } : {}), run: vi.fn() });

describe("frameChords", () => {
  it("names only Cmd/Ctrl chords of commands that change the view or open a draft, per platform", () => {
    const registry = registryWith((context) => {
      context.registerCommand(command("view.a", "read"));
      context.registerCommand(command("runtime.new-session", "write"));
      context.registerCommand(command("thread.settle", "write"));
      context.registerCommand(command("untagged"));
      context.registerCommand(command("view.plain", "read"));
      context.registerKeybinding({ keys: "mod+k", commandId: "view.a" });
      context.registerKeybinding({ keys: "mod+shift+]", commandId: "view.a" });
      context.registerKeybinding({ keys: "ctrl+tab", commandId: "view.a" });
      context.registerKeybinding({ keys: "mod+n", commandId: "runtime.new-session" });
      context.registerKeybinding({ keys: "mod+shift+s", commandId: "thread.settle" });
      context.registerKeybinding({ keys: "mod+u", commandId: "untagged" });
      context.registerKeybinding({ keys: "escape", commandId: "view.plain" });
      context.registerKeybinding({ keys: "alt+x", commandId: "view.plain" });
    });
    const chord = (key: string, init: object) => ({ key, shiftKey: false, altKey: false, ...init });
    expect(frameChords(registry, true)).toEqual([
      chord("k", { metaKey: true, ctrlKey: false }),
      chord("]", { metaKey: true, ctrlKey: false, shiftKey: true }),
      chord("tab", { metaKey: false, ctrlKey: true }),
      chord("n", { metaKey: true, ctrlKey: false }),
    ]);
    expect(frameChords(registry, false)).toEqual([
      chord("k", { metaKey: false, ctrlKey: true }),
      chord("]", { metaKey: false, ctrlKey: true, shiftKey: true }),
      chord("tab", { metaKey: false, ctrlKey: true }),
      chord("n", { metaKey: false, ctrlKey: true }),
    ]);
  });

  it("leaves a chord to the page when any live binding gives it to another command", () => {
    const registry = registryWith((context) => {
      context.registerCommand(command("view.a", "read"));
      context.registerCommand(command("thread.settle", "write"));
      context.registerKeybinding({ keys: "mod+j", commandId: "view.a", when: "terminalFocus" });
      context.registerKeybinding({ keys: "mod+j", commandId: "thread.settle", when: "!terminalFocus" });
    });
    expect(frameChords(registry)).toEqual([]);
  });
});

describe("replayableKey", () => {
  const registry = registryWith((context) => {
    context.registerCommand(command("view.a", "read"));
    context.registerCommand(command("thread.settle", "write"));
    context.registerKeybinding({ keys: "ctrl+k", commandId: "view.a" });
    context.registerKeybinding({ keys: "ctrl+shift+s", commandId: "thread.settle" });
  });
  const key = { key: "k", code: "KeyK", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, repeat: false };

  it("builds the keydown for a chord that changes the view", () => {
    const event = replayableKey(registry, key)!;
    expect(event.type).toBe("keydown");
    expect(event).toMatchObject({ key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true });
  });

  it("refuses a key without Cmd or Ctrl, one nothing is bound to, and one that would change a thread", () => {
    expect(replayableKey(registry, { ...key, ctrlKey: false })).toBeUndefined();
    expect(replayableKey(registry, { ...key, key: "q", code: "KeyQ" })).toBeUndefined();
    expect(replayableKey(registry, { ...key, key: "s", code: "KeyS", shiftKey: true })).toBeUndefined();
  });
});
