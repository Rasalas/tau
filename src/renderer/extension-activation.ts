import { runAll } from "./extension-lifecycle-errors";

/** Owns one activation's resources. A replacement always gets a new lifetime. */
export class ExtensionActivation {
  private readonly controller = new AbortController();
  private readonly disposers = new Set<() => void>();

  get active(): boolean { return !this.signal.aborted; }
  get signal(): AbortSignal { return this.controller.signal; }

  own(dispose: () => void): () => void {
    const release = () => {
      if (this.disposers.delete(release)) dispose();
    };
    this.disposers.add(release);
    if (!this.active) release();
    return release;
  }

  guard<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result | undefined {
    return (...args) => this.active ? callback(...args) : undefined;
  }

  dispose(): void {
    if (!this.active) return;
    this.controller.abort();
    runAll([...this.disposers].reverse());
  }
}
