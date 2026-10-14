/** A pending optimization can become foreground work without waiting behind other optimizations. */
export interface PreparedWork<T> {
  result: Promise<T | undefined>;
  start(): void;
  cancel(): void;
}

/** Shares one optional-work slot across runtime and catalog preparation. */
export class HostPreparationQueue {
  private readonly waiting = new Set<{ start(): void; cancel(): void }>();
  private running = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly canRun: () => boolean = () => true) {}

  schedule<T>(action: () => Promise<T>): PreparedWork<T> {
    let started = false;
    let settled = false;
    let resolve!: (value: T | undefined) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T | undefined>((done, fail) => { resolve = done; reject = fail; });
    const work: PreparedWork<T> = {
      result,
      start: () => {
        if (started || settled || this.disposed) return;
        started = true;
        this.waiting.delete(work);
        this.running++;
        // An explicit consumer promotes the work immediately. Automatic starts
        // always enter on a separate event-loop turn through pump().
        void Promise.resolve().then(action).then(resolve, reject).finally(() => {
          settled = true;
          this.running--;
          this.pump();
        });
      },
      cancel: () => {
        if (started || settled) return;
        settled = true;
        this.waiting.delete(work);
        resolve(undefined);
      },
    };
    if (this.disposed) work.cancel();
    else { this.waiting.add(work); this.pump(); }
    return work;
  }

  private pump(): void {
    if (this.disposed || this.timer || this.running || !this.waiting.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.running) return;
      if (this.canRun()) this.waiting.values().next().value?.start();
      else this.pump();
    }, this.canRun() ? 0 : 100);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const work of this.waiting) work.cancel();
  }
}
