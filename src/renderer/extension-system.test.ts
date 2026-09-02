import { describe, expect, it } from "vitest";
import { ExtensionRegistry } from "./extension-system";

describe("ExtensionRegistry contribution selectors", () => {
  it("keeps sorted contribution references stable between reads", () => {
    const registry = new ExtensionRegistry();
    registry.addKnown({ id: "test", name: "Test", activate(context) {
      context.registerPanel({ id: "panel", label: "Panel", glyph: "p", Component: () => null });
    } });
    registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerPanel({ id: "panel", label: "Panel", glyph: "p", Component: () => null });
    } });
    expect(registry.getPanels()).toBe(registry.getPanels());
  });

  it("rejects cross-extension contribution collisions without removing the owner", () => {
    const registry = new ExtensionRegistry();
    registry.activate({ id: "first", name: "First", activate(context) {
      context.registerPanel({ id: "shared", label: "First panel", glyph: "1", Component: () => null });
    } });
    expect(() => registry.activate({ id: "second", name: "Second", activate(context) {
      context.registerPanel({ id: "shared", label: "Second panel", glyph: "2", Component: () => null });
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
