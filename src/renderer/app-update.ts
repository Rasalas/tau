import type { AppUpdatePhase } from "../shared/contracts";

/** A Tau release the host downloaded, waiting for a restart (API 1.28.0). */
export interface AppUpdate {
  version: string;
  /** From Restart to the quit: a newer release being fetched, then the install. */
  phase?: AppUpdatePhase | undefined;
  /** 0–100 while `phase` is "downloading". */
  progress?: number | undefined;
  /** Restarts into it. */
  install(): void;
}

/** The downloaded update, for core's toast and a kit's control; it stays after the toast is closed. */
export class AppUpdateStore {
  private update: AppUpdate | undefined;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): AppUpdate | undefined => this.update;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(update: AppUpdate | undefined): void {
    const changed = update?.version !== this.update?.version || update?.phase !== this.update?.phase || update?.progress !== this.update?.progress;
    // The same version again may come with another client's restart.
    this.update = update;
    if (changed) for (const listener of [...this.listeners]) listener();
  }
}
