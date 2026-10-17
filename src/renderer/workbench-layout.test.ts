import { describe, expect, it } from "vitest";
import { layoutTransition, workbenchDisplay, type LayoutAction, type LayoutPreferences, type LayoutSpace } from "./workbench-layout";

const preferences: LayoutPreferences = {
  stageFolded: false, stageMaximized: false, chatFocused: false, spineWanted: false, workspaceSummaryHidden: false,
};
const desktop: LayoutSpace = {
  windowWidth: 1440, sidebarWidth: 248, profile: "desktop", compactForm: "single",
  tabCount: 1, showStartScreen: false, workspaceSummaryAvailable: true,
};
const narrow = { ...desktop, windowWidth: 900 };
const tablet: LayoutSpace = { ...desktop, profile: "compact", compactForm: "split", windowWidth: 1024, sidebarWidth: 320 };
const phone: LayoutSpace = { ...tablet, compactForm: "single", windowWidth: 390, sidebarWidth: 0 };
const apply = (state: LayoutPreferences, action: LayoutAction): LayoutPreferences => ({ ...state, ...layoutTransition(state, action) });

describe("renderer workbench layout", () => {
  it("toggles the displayed workspace area together with tabs, including a summary with no tabs", () => {
    for (const tabCount of [0, 1]) {
      const space = { ...desktop, tabCount };
      const hidden = apply(preferences, { type: "toggle-stage", space });
      expect(workbenchDisplay(hidden, space).rightAreaShown).toBe(false);
      expect(hidden).toMatchObject({ stageFolded: true, workspaceSummaryHidden: true });
      const shown = apply(hidden, { type: "toggle-stage", space });
      expect(workbenchDisplay(shown, space).rightAreaShown).toBe(true);
      expect(shown).toMatchObject({ stageFolded: false, workspaceSummaryHidden: false, chatFocused: false });
    }
  });

  it("expands the stage when the narrow centre currently shows the conversation", () => {
    const chat = { ...preferences, chatFocused: true };
    expect(workbenchDisplay(chat, narrow).rightAreaShown).toBe(false);
    const shown = apply(chat, { type: "toggle-stage", space: narrow });
    expect(workbenchDisplay(shown, narrow)).toMatchObject({ stageExpanded: true, conversationFolded: true });
    expect(workbenchDisplay(apply(shown, { type: "reveal-conversation", stacked: true }), narrow)).toMatchObject({ stageExpanded: false, conversationFolded: false });
  });

  it("restores the conversation after maximizing, resizing and revealing it, even with a spine preference", () => {
    const spine = apply(preferences, { type: "toggle-spine" });
    const maximized = apply(spine, { type: "maximize-stage" });
    expect(workbenchDisplay(maximized, desktop)).toMatchObject({ spine: true, floating: true, conversationFolded: true });
    const revealed = apply(maximized, { type: "reveal-conversation", stacked: true });
    expect(revealed).toMatchObject({ stageMaximized: false, spineWanted: false, chatFocused: true });
    expect(workbenchDisplay(revealed, narrow)).toMatchObject({ stageExpanded: false, conversationFolded: false });
    expect(workbenchDisplay(revealed, desktop)).toMatchObject({ stageExpanded: true, conversationFolded: false });
  });

  it("restores a maximized stage beside chat when it fits and selects chat when it does not", () => {
    const maximized = apply(preferences, { type: "maximize-stage" });
    for (const space of [desktop, narrow, tablet]) {
      const restored = apply(maximized, { type: "toggle-stage-maximized", space });
      expect(workbenchDisplay(restored, space)).toMatchObject({ conversationFolded: false,
        stageExpanded: workbenchDisplay(preferences, space).canSplit });
    }
  });

  it("retains desktop preferences through phone and tablet displays", () => {
    const chosen = { ...preferences, spineWanted: true, stageMaximized: true };
    expect(workbenchDisplay(chosen, phone)).toMatchObject({ stageExpanded: false, conversationFolded: false, spine: false, floating: false, workspaceAreaShown: false });
    expect(workbenchDisplay(chosen, tablet)).toMatchObject({ stageExpanded: true, conversationFolded: true, spine: false, floating: false });
    expect(workbenchDisplay(chosen, desktop)).toMatchObject({ stageExpanded: true, spine: true, floating: true });
    expect(chosen).toMatchObject({ spineWanted: true, stageMaximized: true });
    expect(workbenchDisplay({ ...preferences, spineWanted: true }, { ...desktop, showStartScreen: true })).toMatchObject({ spine: false, floating: false, conversationFolded: false });
  });

  it("keeps summary visibility independent of opening tools and the legacy dock toggle", () => {
    const hidden = apply(preferences, { type: "toggle-workspace-summary" });
    const shown = apply(apply(hidden, { type: "hide-stage" }), { type: "show-stage" });
    expect(workbenchDisplay(shown, desktop)).toMatchObject({ stageExpanded: true, workspaceAreaShown: false });
    const folded = apply(shown, { type: "set-stage-shown", shown: (open) => !open });
    expect(workbenchDisplay(folded, desktop).rightAreaShown).toBe(false);
    expect(apply(folded, { type: "set-stage-shown", shown: true }).workspaceSummaryHidden).toBe(true);
  });

  it("never hides both chat and stage for any combination of preferences, tabs and available space", () => {
    for (let bits = 0; bits < 32; bits++) {
      const choices: LayoutPreferences = {
        stageFolded: Boolean(bits & 1), stageMaximized: Boolean(bits & 2), chatFocused: Boolean(bits & 4),
        spineWanted: Boolean(bits & 8), workspaceSummaryHidden: Boolean(bits & 16),
      };
      for (const space of [desktop, narrow, tablet, phone]) {
        for (const tabCount of [0, 1]) {
          const display = workbenchDisplay(choices, { ...space, tabCount });
          expect(display.conversationFolded && !display.stageExpanded).toBe(false);
          expect(display.spine && !display.stageExpanded).toBe(false);
          expect(display.sideOpen && display.conversationFolded).toBe(false);
          if (tabCount === 0) expect(display.stageExpanded).toBe(false);
        }
      }
    }
  });
});
