/**
 * Tracks whether the workbench has entered snapshot/detail application for this
 * client lifetime. A bootstrap cache may contain a session from an earlier
 * host process, so callers must omit that id until that path has been reached.
 */
export class HostSessionState {
  private applied = false;
  private readonly confirmedListeners = new Set<(sessionId: string) => void>();
  /** Authoritative detail accepted for the shown thread, distinct from cached previews. */
  confirmShown = (sessionId: string): void => { this.confirmedListeners.forEach((listener) => listener(sessionId)); };
  onConfirmed = (listener: (sessionId: string) => void): (() => void) => {
    this.confirmedListeners.add(listener);
    return () => this.confirmedListeners.delete(listener);
  };

  markApplied = (): void => {
    this.applied = true;
  };

  sessionIdFor = (sessionId?: string): string | undefined => this.applied ? sessionId : undefined;
}
