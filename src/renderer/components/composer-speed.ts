import { useCallback, useSyncExternalStore } from "react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ComposerSpeedContribution, ComposerSpeedState } from "../extension-system";

const NO_SPEEDS: readonly ComposerSpeedContribution[] = [];

function answer(speeds: readonly ComposerSpeedContribution[], snapshot: HostSnapshot | undefined): [ComposerSpeedContribution, ComposerSpeedState] | undefined {
  for (const speed of speeds) {
    try {
      const state = speed.read(snapshot);
      if (state) return [speed, state];
    } catch (error) { console.error(`Composer speed ${speed.id} failed`, error); }
  }
  return undefined;
}

/** Fast for the thread, from the first kit that answers for it (`registerComposerSpeed`), and its switch. */
export function useComposerSpeed(speeds: readonly ComposerSpeedContribution[] = NO_SPEEDS, snapshot: HostSnapshot | undefined): { state?: ComposerSpeedState; set?(fast: boolean): void } {
  const subscribe = useCallback((listener: () => void) => {
    const offs = speeds.map((speed) => speed.subscribe(listener));
    return () => { for (const off of offs) off(); };
  }, [speeds]);
  const read = () => answer(speeds, snapshot)?.[1];
  const state = useSyncExternalStore(subscribe, read, read);
  if (!state) return {};
  const owner = answer(speeds, snapshot)?.[0];
  return { state, ...(owner ? { set: (fast: boolean) => void Promise.resolve(owner.set(fast, snapshot)).catch((error: unknown) => console.error(`Composer speed ${owner.id} failed`, error)) } : {}) };
}
