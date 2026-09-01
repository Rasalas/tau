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

  it("owns changes and historical review slots by extension lifecycle", () => {
    const registry = new ExtensionRegistry();
    const component = () => null;
    registry.activate({ id: "workspace", name: "Workspace Kit", activate(context) {
      context.registerChanges({ id: "workspace.changes", Component: component });
      context.registerReview({ id: "workspace.history", kind: "historical", Component: component });
    } });
    expect(registry.getChangesContributions().map((entry) => entry.id)).toEqual(["workspace.changes"]);
    expect(registry.getReviewContributions("historical").map((entry) => entry.id)).toEqual(["workspace.history"]);

    registry.deactivate("workspace");
    expect(registry.getChangesContributions()).toEqual([]);
    expect(registry.getReviewContributions("historical")).toEqual([]);
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
