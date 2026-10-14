/** Short-lived provider answers, including large diffs. Expiry releases idle entries too. */
export class ProviderReadCache {
  private readonly entries = new Map<string, {
    value: Promise<unknown>; at: number; refreshing: boolean; bytes: number;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private bytes = 0;
  private disposed = false;

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 128,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  read<T>(key: string, fresh: boolean, read: () => Promise<T>, coalesceFresh: boolean): Promise<T> {
    const held = this.entries.get(key);
    if (held && ((coalesceFresh && held.refreshing) || (!fresh && this.now() - held.at < this.ttlMs))) {
      // Map insertion order is the eviction order.
      this.entries.delete(key);
      this.entries.set(key, held);
      return held.value as Promise<T>;
    }
    const value = read();
    if (this.disposed) return value;
    this.delete(key);
    const entry = {
      value, at: this.now(), refreshing: fresh && coalesceFresh, bytes: 0,
      timer: setTimeout(() => { if (this.entries.get(key) === entry && !entry.refreshing) this.delete(key); }, this.ttlMs),
    };
    entry.timer.unref?.();
    this.entries.set(key, entry);
    this.trim();
    void value.then((answer) => {
      if (this.entries.get(key) !== entry) return;
      if (entry.refreshing) {
        entry.at = this.now();
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { if (this.entries.get(key) === entry) this.delete(key); }, this.ttlMs);
        entry.timer.unref?.();
      }
      entry.refreshing = false;
      // Bound retained payload, not exact V8 heap. Count two bytes per UTF-16 code unit.
      try { entry.bytes = (typeof answer === "string" ? answer.length : (JSON.stringify(answer)?.length ?? 0)) * 2; }
      catch { this.delete(key); return; }
      this.bytes += entry.bytes;
      this.trim();
    }, () => { if (this.entries.get(key) === entry) this.delete(key); });
    return value;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  forget(suffix: string): void {
    for (const key of this.entries.keys()) if (key.endsWith(suffix)) this.delete(key);
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
  }

  dispose(): void {
    this.disposed = true;
    for (const key of this.entries.keys()) this.delete(key);
  }
}
