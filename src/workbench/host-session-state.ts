/**
 * Tracks whether the workbench has entered snapshot/detail application for this
 * client lifetime. A bootstrap cache may contain a session from an earlier
 * host process, so callers must omit that id until that path has been reached.
 */
export class HostSessionState {
  private applied = false;

  markApplied = (): void => {
    this.applied = true;
  };

  sessionIdFor = (sessionId?: string): string | undefined => this.applied ? sessionId : undefined;
}
