import type { ExtensionRegistry } from "./extension-system";
import type { PreferencesStore } from "./preferences";

/**
 * Keeps a client's desktop halves on the host's list of extensions turned off,
 * so a switch on one device starts or stops the kit on every client at once.
 * Only what moved in the list is touched; an extension still waiting for
 * approval stays off whatever the list says.
 */
export function followExtensionChoices(registry: ExtensionRegistry, preferences: PreferencesStore, log?: (label: string, detail: string) => void): () => void {
  let applied = preferences.getSnapshot().disabledExtensions;
  return preferences.subscribe(() => {
    const next = preferences.getSnapshot().disabledExtensions;
    if (next === applied) return;
    const moved = [...next.filter((id) => !applied.includes(id)), ...applied.filter((id) => !next.includes(id))];
    applied = next;
    if (moved.length === 0) return;
    const known = new Map(registry.getExtensionSummaries().map((summary) => [summary.id, summary]));
    for (const id of moved) {
      const summary = known.get(id);
      if (!summary || summary.core) continue;
      const on = !next.includes(id);
      if (on && summary.granted === false) continue;
      try {
        registry.setActive(id, on);
      } catch (error) {
        log?.("extension.follow.failed", `${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}
