import type { UiEnvironments } from "../shared/environments";
import type { PlatformEnvironments } from "./environments";

/**
 * The machine a look-in tab names, as its host id; undefined for the machine
 * this page shows, whose threads open as any tab does. A name counts when one
 * machine has it. Before the window's list arrived, what the caller named is
 * kept, and the tab settles it once the list is there.
 */
export function lookInMachine(machine: string | undefined, environments: Pick<PlatformEnvironments, "getSnapshot" | "shownElsewhere"> | undefined): string | undefined {
  if (!machine) return undefined;
  const list = environments?.getSnapshot();
  if (!list) return machine === environments?.shownElsewhere ? undefined : machine;
  const id = findMachine(list, machine)?.id ?? machine;
  return id === list.shown ? undefined : id;
}

export function findMachine(list: UiEnvironments, machine: string) {
  const byId = list.environments.find((environment) => environment.id === machine);
  if (byId) return byId;
  const named = list.environments.filter((environment) => environment.name.toLowerCase() === machine.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}
