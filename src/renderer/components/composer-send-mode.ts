import { useCallback, useSyncExternalStore } from "react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ComposerSendMode, ComposerSendModeContribution } from "../extension-system";

const NO_MODES: readonly ComposerSendModeContribution[] = [];

function answer(modes: readonly ComposerSendModeContribution[], snapshot: HostSnapshot | undefined): ComposerSendMode | undefined {
  if (!snapshot) return undefined;
  for (const mode of modes) {
    try {
      const state = mode.read(snapshot);
      if (state) return state;
    } catch (error) { console.error(`Composer send mode ${mode.id} failed`, error); }
  }
  return undefined;
}

/** What the send button does for the thread, from the first kit that answers (`registerComposerSendMode`). */
export function useComposerSendMode(modes: readonly ComposerSendModeContribution[] = NO_MODES, snapshot: HostSnapshot | undefined): ComposerSendMode | undefined {
  const subscribe = useCallback((listener: () => void) => {
    const offs = modes.map((mode) => mode.subscribe(listener));
    return () => { for (const off of offs) off(); };
  }, [modes]);
  const read = () => answer(modes, snapshot);
  return useSyncExternalStore(subscribe, read, read);
}
