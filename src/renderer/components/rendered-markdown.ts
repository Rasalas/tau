import { getClientStorage } from "../../workbench/client-storage";
import { STORAGE_KEYS } from "../../workbench/storage-keys";

const listeners = new Set<() => void>();
/** What a client without storage keeps until it reloads. */
let unstored = true;

/**
 * Whether a Markdown file in the file tab opens rendered; one choice for all
 * Markdown files on this client, rendered unless turned off.
 */
export const renderedMarkdown = {
  get: (): boolean => {
    const storage = getClientStorage();
    return storage ? storage.get(STORAGE_KEYS.markdownRendered) !== "off" : unstored;
  },
  set: (on: boolean): void => {
    unstored = on;
    getClientStorage()?.set(STORAGE_KEYS.markdownRendered, on ? "on" : "off");
    for (const listener of [...listeners]) listener();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
