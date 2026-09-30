/** Unseen output, kept per shell so switching threads does not clear another thread's activity. */
export class TerminalActivity {
  private unseen: ReadonlySet<string> = new Set();
  private offsets = new Map<string, number>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.unseen;

  output(id: string, offset: number): void {
    if (!Number.isFinite(offset) || offset <= (this.offsets.get(id) ?? 0)) return;
    this.offsets.set(id, offset);
    if (this.unseen.has(id)) return;
    this.publish(new Set([...this.unseen, id]));
  }

  read(ids: readonly string[]): void {
    const next = new Set(this.unseen);
    for (const id of ids) next.delete(id);
    if (next.size !== this.unseen.size) this.publish(next);
  }

  reset(): void { this.offsets.clear(); this.publish(new Set()); }

  private publish(next: ReadonlySet<string>): void {
    this.unseen = next;
    for (const listener of this.listeners) listener();
  }
}
