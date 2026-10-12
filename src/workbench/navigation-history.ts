/** Where the conversation column stood: a thread, and the view open in place of its transcript. */
export interface NavigationEntry {
  threadId: string;
  view?: { id: string; params: Readonly<Record<string, unknown>> };
}

/** Kept like a browser's session history, which this mirrors for ⌘[ and ⌘] (T3 Code's `navigation.back`). */
const LIMIT = 50;

export function sameEntry(left: NavigationEntry | undefined, right: NavigationEntry | undefined): boolean {
  if (!left || !right) return left === right;
  return left.threadId === right.threadId && left.view?.id === right.view?.id
    && JSON.stringify(left.view?.params ?? null) === JSON.stringify(right.view?.params ?? null);
}

/** The threads and views visited in this window; a visit after going back drops what lay ahead, as a browser does. */
export class NavigationHistory {
  private entries: NavigationEntry[] = [];
  private index = -1;

  current(): NavigationEntry | undefined {
    return this.entries[this.index];
  }

  visit(entry: NavigationEntry): void {
    if (sameEntry(entry, this.current())) return;
    this.entries = [...this.entries.slice(0, this.index + 1), entry].slice(-LIMIT);
    this.index = this.entries.length - 1;
  }

  /**
   * Moves one step and answers where to, past threads `exists` says are gone;
   * `from` is what is on screen, so a draft, which is never an entry, goes back
   * to the thread it was opened from.
   */
  step(direction: -1 | 1, from: NavigationEntry | undefined, exists: (threadId: string) => boolean = () => true): NavigationEntry | undefined {
    if (direction === -1 && from === undefined && this.current() && exists(this.current()!.threadId)) return this.current();
    for (let index = this.index + direction; index >= 0 && index < this.entries.length; index += direction) {
      if (!exists(this.entries[index]!.threadId)) continue;
      this.index = index;
      return this.entries[index];
    }
    return undefined;
  }
}
