import { useEffect } from "react";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { errorMessage } from "../workbench/error-message";

export function useAppKeybindings(
  registry: ExtensionRegistry,
  actions: WorkbenchActions,
  onNotice: (message: string) => void,
): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const match = registry.matchKeybinding(event);
      if (!match) return;
      if (!match.modified && document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      Promise.resolve(match.command.run(actions)).catch((error) => onNotice(`${match.command.id}: ${errorMessage(error)}`));
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [actions, onNotice, registry]);
}
