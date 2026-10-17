import { centerLayout } from "../workbench/center-layout";
import type { ClientProfile, CompactForm } from "../workbench/client-profile";

/** User choices, independent of whether the current device can draw them. */
export interface LayoutPreferences {
  stageFolded: boolean;
  stageMaximized: boolean;
  chatFocused: boolean;
  spineWanted: boolean;
  workspaceSummaryHidden: boolean;
}

export interface LayoutSpace {
  windowWidth: number;
  sidebarWidth: number;
  profile: ClientProfile;
  compactForm: CompactForm;
  tabCount: number;
  showStartScreen: boolean;
  workspaceSummaryAvailable: boolean;
}

/** Derive the display without rewriting choices when the window or profile changes. */
export function workbenchDisplay(preferences: LayoutPreferences, space: LayoutSpace) {
  const compact = space.profile === "compact";
  const phone = compact && space.compactForm !== "split";
  const folded = preferences.stageMaximized || (preferences.spineWanted && !compact && !space.showStartScreen);
  const { stageShown, tabs: stacked, canSplit } = centerLayout({
    windowWidth: space.windowWidth, sidebarWidth: space.sidebarWidth,
    stageOpen: space.tabCount > 0 && !phone, folded: preferences.stageFolded, maximized: folded,
  });
  const conversationFolded = stacked && (folded || !preferences.chatFocused);
  const stageExpanded = stageShown && !(stacked && !folded && preferences.chatFocused);
  const spine = preferences.spineWanted && stageExpanded && canSplit && !compact && !space.showStartScreen;
  const floating = conversationFolded && stageExpanded && !compact && !space.showStartScreen;
  const workspaceAreaShown = space.workspaceSummaryAvailable && !phone && !preferences.workspaceSummaryHidden && (canSplit || stageExpanded);
  return {
    stageShown, stacked, canSplit, conversationFolded, stageExpanded, spine, floating, workspaceAreaShown,
    rightAreaShown: workspaceAreaShown || stageExpanded,
    sideOpen: stageShown && !stacked,
    workspaceSummaryControl: space.workspaceSummaryAvailable && canSplit && !stageExpanded && !compact,
    maximizeControl: spine ? { maximized: true, label: "Show conversation" }
      : canSplit || preferences.stageMaximized ? { maximized: preferences.stageMaximized }
      : stacked ? { maximized: true, label: "Show chat" } : undefined,
  };
}

export type LayoutAction =
  | { type: "show-stage" }
  | { type: "hide-stage" }
  | { type: "set-stage-shown"; shown: boolean | ((shown: boolean) => boolean) }
  | { type: "toggle-stage"; space: LayoutSpace }
  | { type: "toggle-workspace-summary" }
  | { type: "toggle-spine" }
  | { type: "reveal-conversation"; stacked: boolean }
  | { type: "maximize-stage" }
  | { type: "toggle-stage-maximized"; space: LayoutSpace }
  | { type: "restore-stage"; space?: LayoutSpace }
  | { type: "navigate"; hadOwner: boolean }
  | { type: "stage-unavailable"; empty: boolean };

/** Only the choices an action changes; persistence keeps its existing owners and keys. */
export function layoutTransition(preferences: LayoutPreferences, action: LayoutAction): Partial<LayoutPreferences> {
  switch (action.type) {
    case "show-stage": return { stageFolded: false, chatFocused: false };
    case "hide-stage": return { stageFolded: true, spineWanted: false };
    case "set-stage-shown": {
      const shown = typeof action.shown === "function" ? action.shown(!preferences.stageFolded) : action.shown;
      return shown ? { stageFolded: false } : { stageFolded: true, spineWanted: false };
    }
    case "toggle-stage": {
      const { rightAreaShown } = workbenchDisplay(preferences, action.space);
      return { stageFolded: rightAreaShown, workspaceSummaryHidden: rightAreaShown,
        ...(!rightAreaShown ? { chatFocused: false } : { spineWanted: false }) };
    }
    case "toggle-workspace-summary": return { workspaceSummaryHidden: !preferences.workspaceSummaryHidden };
    case "toggle-spine": return { spineWanted: !preferences.spineWanted };
    case "reveal-conversation": return { spineWanted: false, stageMaximized: false,
      ...(action.stacked === false ? {} : { chatFocused: true }) };
    case "maximize-stage": return { stageMaximized: true, stageFolded: false, chatFocused: false };
    case "toggle-stage-maximized": {
      const display = workbenchDisplay(preferences, action.space);
      if (display.spine || (!display.canSplit && !preferences.stageMaximized)) return layoutTransition(preferences, { type: "reveal-conversation", stacked: display.stacked });
      return layoutTransition(preferences, preferences.stageMaximized
        ? { type: "restore-stage", space: action.space } : { type: "maximize-stage" });
    }
    case "restore-stage": return { stageMaximized: false,
      ...(action.space ? { chatFocused: !workbenchDisplay(preferences, action.space).canSplit } : {}) };
    case "navigate": return { chatFocused: true, ...(action.hadOwner ? { stageMaximized: false } : {}) };
    case "stage-unavailable": return { spineWanted: false, ...(action.empty ? { stageMaximized: false } : {}) };
  }
}
