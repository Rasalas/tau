import { describe, expect, it } from "vitest";
import { EMPTY_STAGE, openFileTab, openPanelTab } from "../workbench/stage";
import type { PanelContribution } from "./extension-system";
import { maximizeTarget, type PanelLayoutState } from "./use-panel-layout";

const panel = (id: string, extra: Partial<PanelContribution> = {}): PanelContribution => ({ id, label: id, Component: () => null, ...extra });
const panels = [
  panel("changes", { maximizable: true }),
  panel("fixed"),
  panel("terminal", { placement: "drawer", width: "wide", maximizable: true }),
];
const base: PanelLayoutState = { panels, stage: EMPTY_STAGE, activePanel: "changes", maximized: false };

describe("maximizeTarget", () => {
  it("leaves the maximized layout", () => {
    const stage = openPanelTab(EMPTY_STAGE, "changes");
    expect(maximizeTarget({ ...base, stage, maximized: true }, "terminal")).toEqual({ restore: true });
  });

  it("maximizes the drawer panel the keyboard is in before the stage", () => {
    const stage = openFileTab(EMPTY_STAGE, "/repo/a.ts");
    expect(maximizeTarget({ ...base, stage, drawer: "terminal" }, "terminal")).toEqual({ maximize: "terminal" });
    expect(maximizeTarget({ ...base, stage, drawer: "terminal" }, undefined)).toEqual({ stage: true });
    expect(maximizeTarget({ ...base, drawer: "terminal" }, undefined)).toEqual({ maximize: "terminal" });
  });

  it("does nothing with an empty stage and no drawer", () => {
    expect(maximizeTarget(base, undefined)).toEqual({});
    expect(maximizeTarget(base, "fixed")).toEqual({});
  });
});
