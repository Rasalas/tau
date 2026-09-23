import { describe, expect, it } from "vitest";
import { EMPTY_STAGE, openFileTab, openPanelTab } from "../workbench/stage";
import type { PanelContribution } from "./extension-system";
import { maximizeTarget, type PanelLayoutState } from "./use-panel-layout";

const panel = (id: string, extra: Partial<PanelContribution> = {}): PanelContribution => ({ id, label: id, Component: () => null, ...extra });
const panels = [panel("changes", { maximizable: true }), panel("fixed"), panel("terminal", { placement: "drawer", maximizable: true })];
const base: PanelLayoutState = { panels, stage: EMPTY_STAGE, dockOpen: true, activePanel: "changes" };

describe("maximizeTarget", () => {
  it("restores the panel whose tab is in front", () => {
    const stage = openPanelTab(EMPTY_STAGE, "changes");
    expect(maximizeTarget({ ...base, stage }, "terminal")).toEqual({ restore: "changes" });
  });

  it("maximizes the panel the keyboard is in before the dock's", () => {
    expect(maximizeTarget({ ...base, drawer: "terminal" }, "terminal")).toEqual({ maximize: "terminal" });
    expect(maximizeTarget({ ...base, drawer: "terminal" }, undefined)).toEqual({ maximize: "changes" });
  });

  it("leaves a panel alone that did not declare it, is closed, or is already a tab behind another", () => {
    expect(maximizeTarget({ ...base, activePanel: "fixed" }, undefined)).toEqual({});
    expect(maximizeTarget({ ...base, dockOpen: false }, undefined)).toEqual({});
    const behind = openFileTab(openPanelTab(EMPTY_STAGE, "changes"), "/repo/a.ts");
    expect(maximizeTarget({ ...base, stage: behind }, undefined)).toEqual({});
  });
});
