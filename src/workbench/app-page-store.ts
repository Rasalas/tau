/**
 * The app page on screen (Settings aside): which page, and the views it
 * stepped into, the first being the page itself. A client has at most one
 * page open; opening another replaces it.
 */
export interface AppPageView {
  params: Readonly<Record<string, unknown>>;
  /** How the view reads after the page's label in the bar; the first view has none. */
  label?: string;
}

export interface AppPageState {
  id: string;
  views: readonly AppPageView[];
}

export class AppPageStore {
  private state: AppPageState | undefined;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): AppPageState | undefined => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  open = (id: string, params: Readonly<Record<string, unknown>> = {}): void => {
    this.set({ id, views: [{ params }] });
  };

  /**
   * Steps into another view of the open page; `replace` swaps the view on top
   * instead, and `root` leaves every view for the page's own, opened on `params`.
   */
  navigate = (params: Readonly<Record<string, unknown>>, options: { label?: string; replace?: boolean; root?: boolean } = {}): void => {
    const state = this.state;
    if (!state) return;
    if (options.root) { this.set({ id: state.id, views: [{ params }] }); return; }
    const view: AppPageView = { params, ...(options.label ? { label: options.label } : {}) };
    const below = options.replace ? state.views.slice(0, -1) : state.views;
    // The page's own view keeps no label, even when it is replaced.
    this.set({ id: state.id, views: below.length === 0 ? [{ params }] : [...below, view] });
  };

  /** One view back; false at the page's own view, where only closing is left. */
  back = (): boolean => {
    const state = this.state;
    if (!state || state.views.length < 2) return false;
    this.set({ id: state.id, views: state.views.slice(0, -1) });
    return true;
  };

  /** Back to the page's own view. */
  root = (): void => {
    const state = this.state;
    if (state && state.views.length > 1) this.set({ id: state.id, views: state.views.slice(0, 1) });
  };

  close = (): void => {
    if (this.state) this.set(undefined);
  };

  private set(next: AppPageState | undefined): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
