export type ToastType = "info" | "success" | "warning" | "error" | "loading";

export interface ToastAction {
  label: string;
  run(): void;
  /** Leaves the toast up after the action ran; by default it closes. */
  keepOpen?: boolean;
}

export interface ToastOptions {
  /** Showing a toast with an id already on screen replaces it and starts its time again. */
  id?: string;
  type?: ToastType;
  title?: string;
  description?: string;
  actions?: readonly ToastAction[];
  /** Milliseconds on screen while nobody hovers or focuses the stack; 0 keeps it until dismissed. */
  timeoutMs?: number;
  /** What the copy button puts on the clipboard; without it there is no copy button. */
  copyText?: string;
  /** Runs once when the toast goes, whatever closed it. */
  onClose?(): void;
}

export interface Toast extends ToastOptions {
  id: string;
  type: ToastType;
}

export interface ToastHandle {
  id: string;
  update(patch: Omit<ToastOptions, "id">): void;
  dismiss(): void;
}

export const TOAST_TIMEOUT_MS = 5_000;
/** How many toasts the stack shows at once; the older ones wait, without their clocks running. */
export const TOAST_MAX_VISIBLE = 3;

type Schedule = (run: () => void, ms: number) => () => void;

interface Clock {
  remaining: number;
  startedAt?: number;
  cancel?: () => void;
}

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * The window's toast stack, newest first. Each toast's time runs only while
 * it is among the visible ones and the stack is not held — the pointer on it,
 * focus in it, the window hidden — so nothing leaves while someone reads it.
 */
export class ToastStore {
  private toasts: Toast[] = [];
  private readonly clocks = new Map<string, Clock>();
  private readonly holds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private next = 0;
  private readonly schedule: Schedule;
  private readonly now: () => number;
  readonly maxVisible: number;

  constructor(options: { schedule?: Schedule; now?: () => number; maxVisible?: number } = {}) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.maxVisible = options.maxVisible ?? TOAST_MAX_VISIBLE;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Newest first; the first `maxVisible` are on screen. */
  getToasts = (): readonly Toast[] => this.toasts;

  show = (options: ToastOptions): ToastHandle => {
    const id = options.id ?? `toast-${this.next += 1}`;
    const toast: Toast = { ...options, id, type: options.type ?? "info" };
    const existing = this.toasts.find((entry) => entry.id === id);
    this.stopClock(id);
    this.clocks.delete(id);
    // A replaced toast keeps its place only when it is already in front.
    this.toasts = existing && this.toasts[0]?.id === id
      ? [toast, ...this.toasts.slice(1)]
      : [toast, ...this.toasts.filter((entry) => entry.id !== id)];
    this.sync();
    return { id, update: (patch) => this.update(id, patch), dismiss: () => this.dismiss(id) };
  };

  update = (id: string, patch: Omit<ToastOptions, "id">): void => {
    if (!this.toasts.some((entry) => entry.id === id)) return;
    this.toasts = this.toasts.map((entry) => entry.id === id ? { ...entry, ...patch, id, type: patch.type ?? entry.type } : entry);
    if (patch.timeoutMs !== undefined) { this.stopClock(id); this.clocks.delete(id); }
    this.sync();
  };

  dismiss = (id: string): void => {
    const toast = this.toasts.find((entry) => entry.id === id);
    if (!toast) return;
    this.stopClock(id);
    this.clocks.delete(id);
    this.toasts = this.toasts.filter((entry) => entry.id !== id);
    this.sync();
    toast.onClose?.();
  };

  /** Stops every clock while any reason holds; `release` with the same reason lets them run on. */
  hold = (reason: string): void => {
    if (this.holds.has(reason)) return;
    this.holds.add(reason);
    if (this.holds.size === 1) for (const id of this.clocks.keys()) this.stopClock(id);
  };

  release = (reason: string): void => {
    if (!this.holds.delete(reason) || this.holds.size > 0) return;
    this.sync();
  };

  isHeld = (): boolean => this.holds.size > 0;

  dispose(): void {
    for (const id of this.clocks.keys()) this.stopClock(id);
    this.clocks.clear();
    this.toasts = [];
    this.listeners.clear();
  }

  private stopClock(id: string): void {
    const clock = this.clocks.get(id);
    if (!clock?.cancel) return;
    clock.cancel();
    clock.cancel = undefined;
    if (clock.startedAt !== undefined) clock.remaining = Math.max(0, clock.remaining - (this.now() - clock.startedAt));
    clock.startedAt = undefined;
  }

  /** Starts the clocks of the visible toasts that have none running, then tells the listeners. */
  private sync(): void {
    const visible = this.toasts.slice(0, this.maxVisible);
    for (const toast of this.toasts.slice(this.maxVisible)) this.stopClock(toast.id);
    if (this.holds.size === 0) {
      for (const toast of visible) {
        const timeout = toast.timeoutMs ?? TOAST_TIMEOUT_MS;
        if (timeout <= 0 || toast.type === "loading") { this.stopClock(toast.id); this.clocks.delete(toast.id); continue; }
        let clock = this.clocks.get(toast.id);
        if (!clock) { clock = { remaining: timeout }; this.clocks.set(toast.id, clock); }
        if (clock.cancel) continue;
        clock.startedAt = this.now();
        clock.cancel = this.schedule(() => this.dismiss(toast.id), clock.remaining);
      }
    }
    for (const listener of this.listeners) listener();
  }
}
