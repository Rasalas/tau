/** What "Filter reviews" holds, shared by the page and its sidebar, which draws the field. */
export class ReviewsFilter {
  private value = "";
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): string => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set = (value: string): void => {
    if (value === this.value) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  };
}
