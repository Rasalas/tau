// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelIcon } from "./components/PanelIcon";
import { ExtensionRegistry } from "./extension-system";
import { PreferencesStore } from "./preferences";

describe("ExtensionRegistry contribution selectors", () => {
  it("keeps sorted contribution references stable between reads", () => {
    const registry = new ExtensionRegistry();
    registry.addKnown({ id: "test", name: "Test", activate(context) {
      context.registerPanel({ id: "panel", label: "Panel", Component: () => null });
    } });
    registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerPanel({ id: "panel", label: "Panel", Component: () => null });
    } });
    expect(registry.getPanels()).toBe(registry.getPanels());
  });

  it("draws a panel's own icon, and core's fallback for a panel without one", () => {
    const Marker = ({ size = 15 }: { size?: number }) => <i data-size={size} />;
    const registry = new ExtensionRegistry();
    registry.activate({ id: "with", name: "With", activate(context) {
      context.registerPanel({ id: "with", label: "With", Icon: Marker, Component: () => null });
    } });
    registry.activate({ id: "without", name: "Without", activate(context) {
      context.registerPanel({ id: "without", label: "Without", Component: () => null });
    } });
    const [withIcon, withoutIcon] = registry.getPanels();
    expect(render(<PanelIcon Icon={withIcon!.Icon} />).container.querySelector("i")?.dataset.size).toBe("15");
    // Core knows no kit by name: the fallback is what an icon-less panel gets.
    expect(withoutIcon!.Icon).toBeUndefined();
    expect(render(<PanelIcon Icon={withoutIcon!.Icon} size={14} />).container.querySelector("svg")).not.toBeNull();
  });

  it("lets a binding replace a command's default chord, and gives it back on dispose", () => {
    const registry = new ExtensionRegistry();
    const run = vi.fn();
    registry.activateCore({ id: "core", name: "Core", activate(context) {
      context.registerCommand({ id: "runtime.new-session", label: "New thread", group: "Runtime", run });
      context.registerKeybinding({ keys: "ctrl+shift+k", commandId: "runtime.new-session" });
    } });
    const event = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(registry.matchKeybinding(event({ key: "K", ctrlKey: true, shiftKey: true }))?.command.id).toBe("runtime.new-session");

    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerKeybinding({ keys: "alt+k", commandId: "runtime.new-session", replaces: "runtime.new-session" });
    } });
    // The user's own chord is the chord: Tau's default is no longer live.
    expect(registry.matchKeybinding(event({ key: "K", ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(registry.matchKeybinding(event({ key: "k", altKey: true }))?.command.id).toBe("runtime.new-session");
    expect(registry.getKeybindings().map((binding) => binding.keys)).toEqual(["alt+k"]);
    expect(registry.keybindingLabel("runtime.new-session")).toBe(registry.getKeybindings()[0]!.label);

    registry.deactivate("kit");
    expect(registry.matchKeybinding(event({ key: "K", ctrlKey: true, shiftKey: true }))?.command.id).toBe("runtime.new-session");
    expect(registry.getKeybindings().map((binding) => binding.keys)).toEqual(["ctrl+shift+k"]);
  });

  it("stops shadowing when the single binding is disposed, not only on deactivation", () => {
    const registry = new ExtensionRegistry();
    let dispose = () => undefined as void;
    registry.activateCore({ id: "core", name: "Core", activate(context) {
      context.registerCommand({ id: "runtime.model", label: "Model", group: "Runtime", run: () => undefined });
      context.registerKeybinding({ keys: "ctrl+shift+l", commandId: "runtime.model" });
    } });
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      dispose = context.registerKeybinding({ keys: "alt+l", commandId: "runtime.model", replaces: "runtime.model" });
    } });
    expect(registry.getKeybindings().map((binding) => binding.keys)).toEqual(["alt+l"]);
    dispose();
    expect(registry.getKeybindings().map((binding) => binding.keys)).toEqual(["ctrl+shift+l"]);
  });

  it("takes over the chord it replaces instead of reporting a conflict", () => {
    const registry = new ExtensionRegistry();
    registry.activateCore({ id: "core", name: "Core", activate(context) {
      context.registerCommand({ id: "runtime.abort", label: "Abort", group: "Runtime", run: () => undefined });
      context.registerKeybinding({ keys: "ctrl+shift+j", commandId: "runtime.abort" });
    } });
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerKeybinding({ keys: "ctrl+shift+j", commandId: "runtime.abort", replaces: "runtime.abort" });
    } });
    expect(registry.getKeybindingConflicts()).toEqual([]);
    expect(registry.getKeybindings().map((binding) => [binding.keys, binding.extensionId])).toEqual([["ctrl+shift+j", "kit"]]);
    const event = new KeyboardEvent("keydown", { key: "J", ctrlKey: true, shiftKey: true });
    expect(registry.matchKeybinding(event)?.command.id).toBe("runtime.abort");

    registry.deactivate("kit");
    expect(registry.getKeybindings().map((binding) => [binding.keys, binding.extensionId])).toEqual([["ctrl+shift+j", "core"]]);
    expect(registry.matchKeybinding(event)?.command.id).toBe("runtime.abort");
  });

  it("rejects cross-extension contribution collisions without removing the owner", () => {
    const registry = new ExtensionRegistry();
    registry.activate({ id: "first", name: "First", activate(context) {
      context.registerPanel({ id: "shared", label: "First panel", Component: () => null });
    } });
    expect(() => registry.activate({ id: "second", name: "Second", activate(context) {
      context.registerPanel({ id: "shared", label: "Second panel", Component: () => null });
    } })).toThrow("collides with first");
    expect(registry.getPanels().map((panel) => panel.extensionId)).toEqual(["first"]);
  });

  it("runs every disposer and marks the extension inactive after cleanup failure", () => {
    const registry = new ExtensionRegistry();
    let finalDisposed = false;
    registry.activate({ id: "cleanup", name: "Cleanup", activate(context) {
      context.registerCommand({ id: "temporary", label: "Temporary", group: "Test", run() {} });
      return () => { finalDisposed = true; throw new Error("dispose failed"); };
    } });
    expect(() => registry.deactivate("cleanup")).toThrow("cleanup failed");
    expect(finalDisposed).toBe(true);
    expect(registry.getCommands()).toEqual([]);
    expect(registry.isActive("cleanup")).toBe(false);
  });

  it("rolls back contributions when activation fails", () => {
    const registry = new ExtensionRegistry();
    expect(() => registry.activate({ id: "broken", name: "Broken", activate(context) {
      context.registerCommand({ id: "temporary", label: "Temporary", group: "Test", run() {} });
      throw new Error("activation failed");
    } })).toThrow("activation failed");
    expect(registry.getCommands()).toEqual([]);
    expect(registry.isActive("broken")).toBe(false);
  });

  it("hands the stage one document source and drops it with its extension", () => {
    const registry = new ExtensionRegistry();
    const source = {
      id: "workspace.documents",
      loadFile: async (path: string) => ({ path, name: "a", size: 0, kind: "text" as const, text: "" }),
      loadDiff: async (path: string) => ({ path, added: 0, removed: 0, hunks: [] }),
      openInEditor: () => undefined,
      getState: () => ({ changes: { files: [], added: 0, removed: 0 } }),
      subscribe: () => () => undefined,
    };
    registry.activate({ id: "workspace", name: "Workspace Kit", activate(context) { context.registerDocumentSource(source); } });
    expect(registry.getDocumentSource()?.id).toBe("workspace.documents");
    registry.deactivate("workspace");
    expect(registry.getDocumentSource()).toBeUndefined();
  });
});

describe("ExtensionRegistry host seam", () => {
  it("scopes host commands and events to the extension that owns them", async () => {
    const calls: unknown[][] = [];
    const registry = new ExtensionRegistry({ invoke: async (...args) => { calls.push(args); return "ok"; } });
    const seen: unknown[] = [];
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.host.onEvent("changed", (payload) => seen.push(payload));
      void context.host.invoke("changes", { query: {} });
    } });
    expect(calls).toEqual([["kit", "changes", { query: {} }]]);

    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "kit", name: "changed", payload: 1 });
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "other", name: "changed", payload: 2 });
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "kit", name: "other", payload: 3 });
    expect(seen).toEqual([1]);

    registry.deactivate("kit");
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "kit", name: "changed", payload: 4 });
    expect(seen).toEqual([1]);
  });
});

describe("ExtensionRegistry transcript rows", () => {
  it("merges rows per thread in source order, namespaces ids, and drops them on deactivate", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      const rows = context.registerTranscriptRows("cards", 20);
      rows.setRows("s1", [{ id: "a", afterMessageId: "m1", content: null }]);
      rows.setRows("s2", [{ id: "b", content: null }]);
    } });
    registry.activate({ id: "other", name: "Other", activate(context) {
      const rows = context.registerTranscriptRows("notes", 10);
      rows.setRows("s1", [{ id: "n", afterMessageId: "m1", fallbackToTail: true, content: null }]);
    } });
    expect(registry.getTranscriptRows("s1").map((row) => row.id)).toEqual(["notes:n", "cards:a"]);
    expect(registry.getTranscriptRows("s2").map((row) => row.id)).toEqual(["cards:b"]);
    expect(registry.getTranscriptRows(undefined)).toEqual([]);
    expect(registry.getTranscriptRows("s1")).toBe(registry.getTranscriptRows("s1"));

    registry.deactivate("kit");
    expect(registry.getTranscriptRows("s1").map((row) => row.id)).toEqual(["notes:n"]);
    expect(registry.getTranscriptRows("s2")).toEqual([]);
  });

  it("lets a source clear one thread or all, and ignores writes after disposal", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    let handle: import("./extension-system").TranscriptRowsHandle | undefined;
    registry.activate({ id: "kit", name: "Kit", activate(context) { handle = context.registerTranscriptRows("cards"); } });
    handle!.setRows("s1", [{ id: "a", content: null }]);
    handle!.setRows("s2", [{ id: "b", content: null }]);
    handle!.clear("s1");
    expect(registry.getTranscriptRows("s1")).toEqual([]);
    expect(registry.getTranscriptRows("s2")).toHaveLength(1);
    handle!.clear();
    expect(registry.getTranscriptRows("s2")).toEqual([]);
    handle!.dispose();
    handle!.setRows("s2", [{ id: "c", content: null }]);
    expect(registry.getTranscriptRows("s2")).toEqual([]);
  });
});

describe("ExtensionRegistry regions, status line, overlays, and events", () => {
  it("sorts regions per placement and status items by order, and finds overlays by id", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerRegion({ id: "b", placement: "composer-above", order: 20, Component: () => null });
      context.registerRegion({ id: "a", placement: "composer-above", order: 10, Component: () => null });
      context.registerRegion({ id: "f", placement: "transcript-footer", Component: () => null });
      context.registerStatusItem({ id: "right", align: "right", order: 5, Component: () => null });
      context.registerStatusItem({ id: "left", Component: () => null });
      context.registerOverlay({ id: "review", Component: () => null });
    } });
    expect(registry.getRegions("composer-above").map((region) => region.id)).toEqual(["a", "b"]);
    expect(registry.getRegions("transcript-footer").map((region) => region.id)).toEqual(["f"]);
    expect(registry.getRegions("composer-below")).toEqual([]);
    expect(registry.getStatusItems().map((item) => item.id)).toEqual(["left", "right"]);
    expect(registry.getOverlay("review")?.extensionId).toBe("kit");
    expect(registry.getOverlay(undefined)).toBeUndefined();
    registry.deactivate("kit");
    expect(registry.getRegions("composer-above")).toEqual([]);
    expect(registry.getOverlay("review")).toBeUndefined();
  });

  it("forwards workbench events to listeners until the extension is deactivated", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    const seen: string[] = [];
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.events.on("tool-end", (event) => seen.push(`tool:${event.tool.id}`));
      context.events.on("active-thread-changed", (event) => seen.push(`thread:${event.sessionId ?? "none"}`));
    } });
    registry.dispatchWorkbenchEvent({ type: "tool-end", sessionId: "s", tool: { id: "t1", name: "edit", args: {}, status: "done", output: "", startedAt: 0 } as never });
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: "s2" });
    registry.dispatchWorkbenchEvent({ type: "agent-status", sessionId: "s", running: true });
    expect(seen).toEqual(["tool:t1", "thread:s2"]);
    registry.deactivate("kit");
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: "s3" });
    expect(seen).toHaveLength(2);
  });
});

describe("ExtensionRegistry slash commands", () => {
  it("finds a registered slash command with its arguments and drops it on deactivation", () => {
    const registry = new ExtensionRegistry();
    registry.activate({ id: "slash", name: "Slash", activate(context) {
      context.registerSlashCommand({ name: "reload", description: "Reload", run() {} });
    } });
    expect(registry.getSlashCommands().map((command) => command.name)).toEqual(["reload"]);
    expect(registry.findSlashCommand("/reload  now please ")?.args).toBe("now please");
    expect(registry.findSlashCommand("/reload")?.command.extensionId).toBe("slash");
    expect(registry.findSlashCommand("/reloaded")).toBeUndefined();
    expect(registry.findSlashCommand("reload")).toBeUndefined();
    registry.deactivate("slash");
    expect(registry.getSlashCommands()).toEqual([]);
    expect(registry.findSlashCommand("/reload")).toBeUndefined();
  });

  it("rejects slash command names the composer could not trigger", () => {
    const registry = new ExtensionRegistry();
    expect(() => registry.activate({ id: "bad", name: "Bad", activate(context) {
      context.registerSlashCommand({ name: "Re load", run() {} });
    } })).toThrow('Slash command name "Re load"');
    expect(registry.isActive("bad")).toBe(false);
  });
});

describe("ExtensionRegistry keybindings", () => {
  const keydown = (init: Partial<KeyboardEvent> & { key: string }) =>
    ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

  it("binds chords to commands of any extension and dispatches keydown events", () => {
    const registry = new ExtensionRegistry();
    const ran: string[] = [];
    registry.activate({ id: "commands", name: "Commands", activate(context) {
      context.registerCommand({ id: "palette", label: "Palette", group: "Test", run() { ran.push("palette"); } });
    } });
    registry.activate({ id: "keys", name: "Keys", activate(context) {
      context.registerKeybinding({ keys: "Mod+K", commandId: "palette" });
      context.registerKeybinding({ keys: "escape", commandId: "missing" });
    } });
    expect(registry.getKeybindings().map((binding) => [binding.keys, binding.commandId, binding.extensionId])).toEqual([["mod+k", "palette", "keys"], ["escape", "missing", "keys"]]);
    expect(registry.keybindingLabel("palette")).toMatch(/K$/u);
    const mac = /mac/iu.test(navigator.platform);
    const match = registry.matchKeybinding(keydown({ key: "k", metaKey: mac, ctrlKey: !mac }));
    expect(match?.command.id).toBe("palette");
    expect(match?.modified).toBe(true);
    // A chord whose command no extension provides is not a match.
    expect(registry.matchKeybinding(keydown({ key: "Escape" }))).toBeUndefined();
    registry.deactivate("keys");
    expect(registry.getKeybindings()).toEqual([]);
  });

  it("keeps the first binding of a chord and records later ones as conflicts", () => {
    const registry = new ExtensionRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.activate({ id: "first", name: "First", activate(context) {
      context.registerCommand({ id: "first.cmd", label: "First", group: "Test", run() {} });
      context.registerKeybinding({ keys: "mod+shift+s", commandId: "first.cmd" });
    } });
    registry.activate({ id: "second", name: "Second", activate(context) {
      context.registerCommand({ id: "second.cmd", label: "Second", group: "Test", run() {} });
      context.registerKeybinding({ keys: "shift+mod+s", commandId: "second.cmd" });
    } });
    expect(registry.getKeybindings().map((binding) => binding.commandId)).toEqual(["first.cmd"]);
    expect(registry.getKeybindingConflicts()).toEqual([{ keys: "mod+shift+s", commandId: "second.cmd", extensionId: "second", boundTo: { commandId: "first.cmd", extensionId: "first" } }]);
    expect(warn).toHaveBeenCalledOnce();
    registry.deactivate("second");
    expect(registry.getKeybindingConflicts()).toEqual([]);
    expect(() => registry.activate({ id: "bad", name: "Bad", activate(context) {
      context.registerKeybinding({ keys: "hyper+k", commandId: "first.cmd" });
    } })).toThrow('Keybinding "hyper+k"');
    warn.mockRestore();
  });
});

describe("ExtensionRegistry prompt renderers", () => {
  const prompt = (extras?: Record<string, unknown>) => ({ id: "p1", sessionId: "s1", kind: "select" as const, title: "Pick", options: ["a", "b"], extras });

  it("hands matching prompts to their renderer, lets it answer ahead, and hears every answer", () => {
    const registry = new ExtensionRegistry();
    const answered: string[] = [];
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerPromptRenderer({
        id: "marked",
        match: (entry) => Boolean(entry.extras?.["kit"]),
        Component: () => null,
        intercept: (entry) => (entry.extras?.["kit"] === "known" ? { value: "a" } : undefined),
        onAnswered: (_entry, answer) => { answered.push("value" in answer ? answer.value : "other"); },
      });
    } });
    expect(registry.getPromptRenderer(prompt())).toBeUndefined();
    expect(registry.getPromptRenderer(prompt({ kit: true }))?.id).toBe("marked");
    expect(registry.interceptPrompt(prompt({ kit: true }))).toBeUndefined();
    expect(registry.interceptPrompt(prompt({ kit: "known" }))).toEqual({ value: "a" });
    registry.notifyPromptAnswered(prompt({ kit: true }), { value: "b" });
    registry.notifyPromptAnswered(prompt(), { value: "ignored" });
    expect(answered).toEqual(["b"]);
    registry.deactivate("kit");
    expect(registry.getPromptRenderer(prompt({ kit: true }))).toBeUndefined();
  });
});

describe("client profiles", () => {
  const kit = { id: "kit", name: "Kit", activate(context: Parameters<Parameters<ExtensionRegistry["activate"]>[0]["activate"]>[0]) {
    context.registerPanel({ id: "desk", label: "Desk", Component: () => null });
    context.registerStatusItem({ id: "anywhere", profiles: ["desktop", "web", "compact"], Component: () => null });
    context.registerToolRenderer("rows", () => true, () => ({ glyph: "•", title: "t", tone: "neutral" as const, detail: "" }), { profiles: ["web"] });
  } };

  it("draws everything a desktop client claims, and says nothing is missing", () => {
    const registry = new ExtensionRegistry();
    registry.activate(kit);
    expect(registry.getProfile()).toBe("desktop");
    expect(registry.getPanels()).toHaveLength(1);
    expect(registry.getStatusItems()).toHaveLength(1);
    expect(registry.getUnrenderedContributions().map((entry) => entry.id)).toEqual(["rows"]);
  });

  it("leaves out what a web client cannot draw and lists it by name and kind", () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), profile: "web" });
    registry.activate(kit);
    expect(registry.getPanels()).toEqual([]);
    expect(registry.getStatusItems()).toHaveLength(1);
    expect(registry.presentTool({ id: "t", name: "any", args: {} } as never).glyph).toBe("•");
    expect(registry.getUnrenderedContributions().map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["panel:desk"]);
  });

  // A contribution that is not drawn is not a failed one: the extension keeps
  // running, and the disposer it was handed still works.
  it("hands a filtered contribution a disposer that does nothing", () => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), profile: "compact" });
    let dispose: (() => void) | undefined;
    registry.activate({ id: "one", name: "One", activate(context) {
      dispose = context.registerPanel({ id: "p", label: "P", Component: () => null });
    } });
    expect(registry.isActive("one")).toBe(true);
    expect(() => dispose?.()).not.toThrow();
    registry.deactivate("one");
    expect(registry.getUnrenderedContributions()).toEqual([]);
  });
});
