import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { focusAreaBlocked } from "./focus-areas";
import { hostIsReadOnly, READ_ONLY_REASON } from "./use-host-capabilities";
import { KEYBINDING_CAPTURE_ATTRIBUTE, openOverlays } from "./keybinding-context";
import { isImeComposing } from "./keybindings";

/** Commands shared by rail implementations. Each rail owns its model cursor and virtualized focus. */
export function installSidebarKeyboard(registry: ExtensionRegistry, actions: WorkbenchActions, notice: (text: string) => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isImeComposing(event) || registry.getProfile() === "compact" || document.body.dataset.profile === "compact") return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    const list = target?.closest<HTMLElement>('.session-list[aria-label="Threads"]');
    if (!list || target?.closest(`[${KEYBINDING_CAPTURE_ATTRIBUTE}], .thread-row-actions, input, textarea, select, [contenteditable="true"]`)) return;
    // A row's non-modal details card opens while keyboard focus stays on the row.
    // It must not disable that row's rename/menu/Stage commands.
    if (focusAreaBlocked() && openOverlays().some((overlay) => !overlay.matches('.settings-screen, [data-app-page], .thread-card:not([aria-modal="true"])'))) return;
    const main = target?.closest<HTMLElement>(".thread-main");
    const row = main?.closest<HTMLElement>("[data-rail-thread]");
    const take = () => { event.preventDefault(); event.stopPropagation(); };
    if (main && row && (event.key === "F2" || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
      take();
      if (event.key === "F2") {
        if (hostIsReadOnly()) { notice(READ_ONLY_REASON); return; }
        const command = registry.getCommand("runtime.rename-thread");
        if (command) void Promise.resolve(command.run(actions, { threadId: row.dataset.railThread })).catch((error: unknown) => notice(String(error)));
      } else {
        const box = main.getBoundingClientRect();
        main.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.bottom }));
      }
      return;
    }
    if (main && row && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      take(); actions.openThread(row.dataset.railThread!); return;
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
