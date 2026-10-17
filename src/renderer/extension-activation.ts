import { throwFailures } from "./extension-lifecycle-errors";

/** Owns one activation's resources. A replacement always gets a new lifetime. */
export class ExtensionActivation {
  private readonly controller = new AbortController();
  private disposers: Array<() => void> = [];

  get active(): boolean { return !this.signal.aborted; }
  get signal(): AbortSignal { return this.controller.signal; }

  own(dispose: () => void): () => void {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      dispose();
    };
    if (this.active) this.disposers.push(release);
    else release();
    return release;
  }

  guard<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result | undefined {
    return (...args) => this.active ? callback(...args) : undefined;
  }

  dispose(): void {
    if (!this.active) return;
    this.controller.abort();
    const disposers = this.disposers;
    this.disposers = [];
    const errors: unknown[] = [];
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    throwFailures(errors);
  }
}
