import { useEffect } from "react";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { errorMessage } from "../workbench/error-message";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "./keybinding-context";

/**
 * Window keydown to commands. A binding whose `when` needs a context (the
 * terminal's `mod+d` under `terminalFocus`) runs in the capture phase, before
 * the focused element sees the key; every other binding waits for the bubble
 * phase, so a field or a shell that handled the key keeps it.
 */
export function useAppKeybindings(
  registry: ExtensionRegistry,
  actions: WorkbenchActions,
  onNotice: (message: string) => void,
): void {
  useEffect(() => {
    const dispatch = (event: KeyboardEvent, capture: boolean) => {
      if (event.defaultPrevented) return;
      // A field that records chords gets every key, the workbench's own included.
      if (event.target instanceof Element && event.target.closest(`[${KEYBINDING_CAPTURE_ATTRIBUTE}]`)) return;
      const match = registry.matchKeybinding(event);
      if (!match || (capture && !match.specific)) return;
      if (!match.modified && document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (capture) event.stopPropagation();
      Promise.resolve(match.command.run(actions)).catch((error) => onNotice(`${match.command.id}: ${errorMessage(error)}`));
    };
    const early = (event: KeyboardEvent) => dispatch(event, true);
    const late = (event: KeyboardEvent) => dispatch(event, false);
    window.addEventListener("keydown", early, true);
    window.addEventListener("keydown", late);
    return () => {
      window.removeEventListener("keydown", early, true);
      window.removeEventListener("keydown", late);
    };
  }, [actions, onNotice, registry]);
}
