const REFRESH_MS = 60_000;

/** One bounded refresh loop for the requests visible on active surfaces, not every rail row. */
export class RequestRefresh {
  private readonly watched = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly read: (key: string) => void) {}
  private visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  private refresh = () => { if (this.visible()) for (const key of this.watched.keys()) this.read(key); };

  watch(key: string): () => void {
    this.watched.set(key, (this.watched.get(key) ?? 0) + 1);
    if (!this.timer) {
      this.timer = setInterval(this.refresh, REFRESH_MS);
      if (typeof window !== "undefined") window.addEventListener("focus", this.refresh);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.refresh);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.watched.get(key) ?? 1) - 1;
      if (remaining > 0) this.watched.set(key, remaining); else this.watched.delete(key);
      if (this.watched.size === 0) this.stop();
    };
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (typeof window !== "undefined") window.removeEventListener("focus", this.refresh);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.refresh);
  }
  dispose(): void { this.watched.clear(); this.stop(); }
}
