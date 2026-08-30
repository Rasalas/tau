export class ToolOutputBatcher {
  private pending = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly flushUpdates: (updates: ReadonlyMap<string, string>) => void,
    private readonly intervalMs = 16,
  ) {}

  push(id: string, output: string): void {
    this.pending.set(id, output);
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  flushId(id: string): void {
    const output = this.pending.get(id);
    if (output === undefined) return;
    this.pending.delete(id);
    this.flushUpdates(new Map([[id, output]]));
  }

  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const pending = this.pending;
    this.pending = new Map();
    this.flushUpdates(pending);
  }

  dispose(): void {
    this.flush();
  }
}
