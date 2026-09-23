import { getClientStorage } from "../../workbench/client-storage";
import { STORAGE_KEYS } from "../../workbench/storage-keys";

const listeners = new Set<() => void>();

/**
 * Whether scrolling back through a thread folds an idle composer; this
 * client's own choice, on unless turned off. Kept out of the preferences
 * so it loads with the chip layer and the settings page, not at start.
 */
export const composerFold = {
  get: (): boolean => getClientStorage()?.get(STORAGE_KEYS.composerFold) !== "off",
  set: (on: boolean): void => {
    getClientStorage()?.set(STORAGE_KEYS.composerFold, on ? "on" : "off");
    for (const listener of [...listeners]) listener();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
