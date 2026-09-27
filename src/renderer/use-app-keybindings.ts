import { useEffect } from "react";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { errorMessage } from "../workbench/error-message";
import { domKeybindingContext, KEYBINDING_CAPTURE_ATTRIBUTE } from "./keybinding-context";
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
  onNotice: (message: string) => void,
): void {
  useEffect(() => {
    const chosen = new WeakMap<KeyboardEvent, Match>();
    const run = (match: Match) => {
      const refused = commandRefusal(match.command, hostIsReadOnly());
      if (refused) { onNotice(refused); return; }
      Promise.resolve(match.command.run(actions)).catch((error) => onNotice(`${match.command.id}: ${errorMessage(error)}`));
    };
    const early = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // A field that records chords gets every key, the workbench's own included.
      if (event.target instanceof Element && event.target.closest(`[${KEYBINDING_CAPTURE_ATTRIBUTE}]`)) return;
      const context = domKeybindingContext();
      const match = registry.matchKeybinding(event, context);
      if (!match || (!match.modified && context("overlayOpen"))) return;
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
      window.removeEventListener("keydown", early, true);
      window.removeEventListener("keydown", late);
    };
  }, [actions, onNotice, registry]);
}
