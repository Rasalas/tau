import { useState } from "react";

/**
 * What the reader opened or closed among one thread's work rows, by row id.
 * It outlives a row the virtual list unmounts; a thread opened again starts empty.
 */
export class WorkDisclosures {
  private readonly toggled = new Map<string, boolean>();
  /** Turns, by their first call's id, in which the reader opened something. */
  private readonly openedTurns = new Set<string>();

  get(id: string): boolean | undefined {
    return this.toggled.get(id);
  }

  set(id: string, open: boolean, turn?: string): void {
    this.toggled.set(id, open);
    if (open && turn !== undefined) this.openedTurns.add(turn);
  }

  /**
   * Whether the reader opened anything in this turn. Keyed by the turn's first
   * call, which stays the same when the settled turn moves into the history.
   */
  openedInTurn(turn: string): boolean {
    return this.openedTurns.has(turn);
  }
}

/** A row's open state: the reader's own choice when there is one, else the row's default. */
export function useDisclosure(disclosures: WorkDisclosures | undefined, id: string, initial: boolean, turn?: string): [boolean, (open: boolean) => void] {
  const [toggled, setToggled] = useState<boolean | undefined>(() => disclosures?.get(id));
  const toggle = (open: boolean) => {
    disclosures?.set(id, open, turn);
    setToggled(open);
  };
  return [toggled ?? initial, toggle];
}
