import { describe, expect, it } from "vitest";
import { EMPTY_STAGE, openFileTab, openPanelTab } from "../workbench/stage";
import type { PanelContribution } from "./extension-system";
import { isWidePanel, maximizeTarget, type PanelLayoutState } from "./use-panel-layout";

const panel = (id: string, extra: Partial<PanelContribution> = {}): PanelContribution => ({ id, label: id, Component: () => null, ...extra });
const panels = [
  panel("changes", { maximizable: true }),
  panel("fixed"),
  panel("preview", { width: "wide", maximizable: true }),
  panel("terminal", { placement: "drawer", width: "wide", maximizable: true }),
];
const base: PanelLayoutState = { panels, stage: EMPTY_STAGE, dockOpen: true, activePanel: "changes", maximized: false };

describe("maximizeTarget", () => {
  it("leaves the maximized layout, naming the panel tab in front", () => {
    const stage = openPanelTab(EMPTY_STAGE, "changes");
    expect(maximizeTarget({ ...base, stage, maximized: true }, "terminal")).toEqual({ restore: true, panel: "changes" });
    expect(maximizeTarget({ ...base, stage: openFileTab(stage, "/repo/a.ts"), maximized: true }, undefined)).toEqual({ restore: true });
  });

  it("maximizes the panel the keyboard is in before the dock's", () => {
    expect(maximizeTarget({ ...base, drawer: "terminal" }, "terminal")).toEqual({ maximize: "terminal" });
    expect(maximizeTarget({ ...base, drawer: "terminal" }, undefined)).toEqual({ maximize: "changes" });
  });

  it("maximizes a wide tool beside the chat, else the documents before a list docked at their side", () => {
    const stage = openFileTab(EMPTY_STAGE, "/repo/a.ts");
    expect(maximizeTarget({ ...base, stage, activePanel: "preview" }, undefined)).toEqual({ maximize: "preview" });
    expect(maximizeTarget({ ...base, stage }, undefined)).toEqual({ stage: true });
  });

  it("leaves a panel alone that did not declare it or is closed", () => {
    expect(maximizeTarget({ ...base, activePanel: "fixed" }, undefined)).toEqual({});
    expect(maximizeTarget({ ...base, dockOpen: false }, undefined)).toEqual({});
  });
});

describe("isWidePanel", () => {
  it("counts a dock panel that asked for it, never one in the drawer", () => {
    expect(isWidePanel(panels, "preview")).toBe(true);
    expect(isWidePanel(panels, "changes")).toBe(false);
    expect(isWidePanel(panels, "terminal")).toBe(false);
  });
});
