import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "./extension-system";
import { AppPageStore } from "../workbench/app-page-store";
import { withAppPages } from "./app-page-actions";

describe("withAppPages", () => {
  it("opens pages over Settings and leaves them for a thread", async () => {
    const pages = new AppPageStore();
    const closeSettings = vi.fn();
    const switchSession = vi.fn(async () => true);
    const actions = withAppPages({ switchSession, openSettings: vi.fn() } as unknown as WorkbenchActions, pages, closeSettings);
    actions.openPage?.("usage", { range: "30d" });
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(pages.getSnapshot()).toEqual({ id: "usage", views: [{ params: { range: "30d" } }] });
    // Settings opens over a page; the page is still there after it.
    actions.openSettings();
    expect(pages.getSnapshot()?.id).toBe("usage");
    await expect(actions.switchSession("/a.jsonl")).resolves.toBe(true);
    expect(switchSession).toHaveBeenCalledWith("/a.jsonl");
    expect(pages.getSnapshot()).toBeUndefined();
    actions.openPage?.("usage");
    actions.closePage?.();
    expect(pages.getSnapshot()).toBeUndefined();
  });
});
