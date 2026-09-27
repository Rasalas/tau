import { useState } from "react";

/**
 * What the reader opened or closed among one thread's work rows, by row id.
 * It outlives a row the virtual list unmounts; a thread opened again starts empty.
 */
export class WorkDisclosures {
  private readonly toggled = new Map<string, boolean>();

  get(id: string): boolean | undefined {
    return this.toggled.get(id);
  }

  set(id: string, open: boolean): void {
    this.toggled.set(id, open);
  }

  /** Whether the reader opened any row whose id starts with `prefix`. */
  openedUnder(prefix: string): boolean {
    for (const [id, open] of this.toggled) if (open && id.startsWith(prefix)) return true;
    return false;
  }
}

/** A row's open state: the reader's own choice when there is one, else the row's default. */
export function useDisclosure(disclosures: WorkDisclosures | undefined, id: string, initial: boolean): [boolean, (open: boolean) => void] {
  const [toggled, setToggled] = useState<boolean | undefined>(() => disclosures?.get(id));
  const toggle = (open: boolean) => {
    disclosures?.set(id, open);
    setToggled(open);
  };
  return [toggled ?? initial, toggle];
}
