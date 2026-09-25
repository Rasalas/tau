import type { PlatformEnvironments } from "tau";
import { Cell } from "./screen-store.js";

/** The window's machines, when this client has a window process (API 1.13.0); the look-in reads through it. */
export const environmentsCell = new Cell<PlatformEnvironments | undefined>(undefined);

/** The name of the other machine this page shows; undefined on the window's own machine, a phone or a browser. */
export const hostMachineName = new Cell<string | undefined>(undefined);

/**
 * Follows the name of the machine the page shows when it is not the window's
 * own; the window's own list is read only then.
 */
export function followHostMachine(environments: PlatformEnvironments | undefined): () => void {
  environmentsCell.set(environments);
  const elsewhere = environments?.shownElsewhere;
  if (!environments || !elsewhere) return () => environmentsCell.set(undefined);
  const read = () => hostMachineName.set(environments.getSnapshot()?.environments.find((entry) => entry.id === elsewhere)?.name);
  read();
  const stop = environments.subscribe(read);
  return () => {
    stop();
    environmentsCell.set(undefined);
    hostMachineName.set(undefined);
  };
}
