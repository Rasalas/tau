// @vitest-environment jsdom
import { queryObjects } from "node:v8";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ExtensionRegistry, type DesktopExtensionContext } from "./extension-system";

describe("workbench event subscription memory", () => {
  it("releases a removed listener's captured state while its extension stays active", async () => {
    class CapturedState {
      calls = 0;
    }

    const registry = new ExtensionRegistry();
    let context!: DesktopExtensionContext;
    registry.activate({ id: "memory", name: "Memory", activate(given) { context = given; } });

    // Components subscribe again as their captured view state changes. Merely
    // stopping event delivery must not leave every old view in the activation.
    const subscribe = () => {
      const state = new CapturedState();
      return context.events.on("prompt-accepted", () => { state.calls += 1; });
    };
    const count = () => queryObjects(CapturedState, { format: "count" });

    expect(count()).toBe(0);
    const resubscribe = () => {
      for (let index = 0; index < 40; index += 1) subscribe()();
    };
    resubscribe();
    // V8 may keep the last called function in a stack slot until this turn ends.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      expect(registry.isActive("memory")).toBe(true);
      expect(count()).toBe(0);
    } finally {
      registry.deactivate("memory");
    }
  });

  it("releases the content of a disposed transcript row source", () => {
    class CapturedRow {
      text = "row";
    }
    const registry = new ExtensionRegistry();
    let context!: DesktopExtensionContext;
    registry.activate({ id: "rows", name: "Rows", activate(given) { context = given; } });
    const publishAndDispose = () => {
      const row = new CapturedRow();
      const source = context.registerTranscriptRows("temporary");
      source.setRows("thread", [{ id: "row", content: createElement(() => row.text) }]);
      source.dispose();
    };
    for (let index = 0; index < 40; index += 1) publishAndDispose();
    try {
      expect(registry.isActive("rows")).toBe(true);
      expect(queryObjects(CapturedRow, { format: "count" })).toBe(0);
    } finally {
      registry.deactivate("rows");
    }
  });
});
