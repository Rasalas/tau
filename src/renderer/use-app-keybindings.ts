import { installSidebarKeyboard } from "./sidebar-keyboard";
import { installFocusAreas, focusAreaBlocked } from "./focus-areas";
import { useEffect } from "react";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { errorMessage } from "../workbench/error-message";
import { domKeybindingContext, KEYBINDING_CAPTURE_ATTRIBUTE } from "./keybinding-context";
import { isImeComposing } from "./keybindings";
import { commandRefusal, hostIsReadOnly } from "./use-host-capabilities";

type Match = NonNullable<ReturnType<ExtensionRegistry["matchKeybinding"]>>;

/**
 * Window keydown to commands. The binding is chosen in the capture phase,
 * against the page as the key went down: an overlay that closes itself on
 * Escape, or hands focus back, must not change what that same key means. A
 * specific chord with a modifier (the terminal's `mod+d` under
 * `terminalFocus`) runs right there, before the focused element sees the key;
 * every other one waits for the bubble phase, so a field or a shell that
 * handled the key (`preventDefault()`) keeps it. A bare key never runs while
 * an overlay is open: its Escape closes the overlay and stops nothing.
 */
export function useAppKeybindings(
  registry: ExtensionRegistry,
  actions: WorkbenchActions,
  onNotice: (message: string, level?: "info" | "warning" | "error") => void,
): void {
  useEffect(() => {
    const stopSidebar = installSidebarKeyboard(registry, actions, onNotice);
    const stopAreas = registry.getProfile() === "compact" ? () => undefined : installFocusAreas(() => registry.getFocusAreas());
    const chosen = new WeakMap<KeyboardEvent, Match>();
    const run = (match: Match) => {
      const refused = commandRefusal(match.command, hostIsReadOnly());
      if (refused) { onNotice(refused); return; }
      Promise.resolve(match.command.run(actions)).catch((error) => onNotice(`${match.command.label}: ${errorMessage(error)}`, "error"));
    };
    const early = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposing(event)) return;
      // A field that records chords gets every key, the workbench's own included.
      if (event.target instanceof Element && event.target.closest(`[${KEYBINDING_CAPTURE_ATTRIBUTE}]`)) return;
      const context = domKeybindingContext();
      const match = registry.matchKeybinding(event, context);
      const areaCommand = match?.command.id === "workbench.focus-next-area" || match?.command.id === "workbench.focus-previous-area";
      if (areaCommand && (focusAreaBlocked() || (registry.getProfile() === "compact" || document.body.dataset.profile === "compact"))) return;
      if (!match || (!areaCommand && !match.modified && context("overlayOpen"))) return;
      // F6 is a workbench navigation key even while an editor or terminal owns bare function keys.
      if (areaCommand) { event.preventDefault(); event.stopPropagation(); run(match); return; }
      if (!match.specific || !match.modified) { chosen.set(event, match); return; }
      event.preventDefault();
      event.stopPropagation();
      run(match);
    };
    const late = (event: KeyboardEvent) => {
      const match = chosen.get(event);
      if (!match || event.defaultPrevented) return;
      event.preventDefault();
      run(match);
    };
    window.addEventListener("keydown", early, true);
    window.addEventListener("keydown", late);
    return () => {
      stopSidebar();
      stopAreas();
      window.removeEventListener("keydown", early, true);
      window.removeEventListener("keydown", late);
    };
  }, [actions, onNotice, registry]);
}
