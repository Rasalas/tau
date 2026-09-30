import { describe, expect, it } from "vitest";
import type { PanelContribution } from "../extension-system";
import { stageToolLayout } from "./stage-tool-layout";

const panels = ["files", "terminal", "agents", "review"].map((id) => ({ id, stageButton: id === "files" || id === "terminal" }) as PanelContribution);
const ids = (items: readonly PanelContribution[]) => items.map((item) => item.id);

describe("tool visibility", () => {
  it("promotes open tools in registry order and puts them back when closed", () => {
    const open = stageToolLayout(panels, new Set(["review", "agents"]), new Set(["agents"]));
    expect(ids(open.buttons)).toEqual(["files", "terminal", "agents", "review"]);
    expect(open.rest).toEqual([]);
    const closed = stageToolLayout(panels, new Set(["review"]), new Set());
    expect(ids(closed.buttons)).toEqual(["files", "terminal", "review"]);
    expect(ids(closed.rest)).toEqual(["agents"]);
  });

  it("keeps the current tool reachable while moving excess tools into overflow", () => {
    const narrow = stageToolLayout(panels, new Set(["agents", "review"]), new Set(["review"]), 3);
    expect(ids(narrow.buttons)).toEqual(["files", "review"]);
    expect(ids(narrow.rest)).toEqual(["terminal", "agents"]);
    const smallest = stageToolLayout(panels, new Set(["agents"]), new Set(["agents"]), 1);
    expect(smallest.buttons).toEqual([]);
    expect(ids(smallest.rest)).toEqual(ids(panels));
  });
});
