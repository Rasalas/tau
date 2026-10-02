import type { HostActivationTransaction } from "./host-extensions.js";
import type { HostActivationLease } from "./host-lifecycle-coordinator.js";
import type { ThreadRuntime } from "./thread-runtime.js";

export interface VisibleThreadState {
  active: ThreadRuntime | undefined;
  cwd: string;
  extensionCount: number;
}

/**
 * The small host surface needed to promote one runtime. It is intentionally
 * about activation order and visible state; runtime construction, backend
 * selection and reporting stay with their owners.
 */
export interface ThreadActivationPort {
  assertHostOwned(thread: ThreadRuntime): void;
  isCurrentRuntime(thread: ThreadRuntime): boolean;
  beforeActivate(thread: ThreadRuntime): Promise<HostActivationTransaction | undefined>;
  /** Adopt an absent slot; the port must reject a different runtime for the id. */
  adopt(thread: ThreadRuntime): Promise<void>;
  captureVisibleState(): VisibleThreadState;
  /** Publish the pointer together with the transaction generation it owns. */
  setVisible(thread: ThreadRuntime, generation: number): void;
  restoreVisibleState(state: VisibleThreadState, expected: ThreadRuntime, generation: number): void;
  rememberProject(cwd: string): Promise<void>;
  refreshShell(thread: ThreadRuntime, touch: boolean): Promise<void>;
  publishVisible(thread: ThreadRuntime): void;
}

/**
 * Owns the visible activation transaction: host ownership, extension hooks,
 * registry adoption, pointer publication, stale checks, and rollback. The
 * pointers and project publication precede the extension commit, preserving
 * the host's existing activation order.
 */
export class ThreadActivation {
  private visibleGeneration = 0;

  constructor(private readonly port: ThreadActivationPort) {}

  async promote(thread: ThreadRuntime, touch: boolean, activation: HostActivationLease): Promise<boolean> {
    if (!activation.isCurrent()) return false;
    this.port.assertHostOwned(thread);
    const previous = this.port.captureVisibleState();
    const restore = await this.port.beforeActivate(thread);
    let pointerChanged = false;
    let pointerGeneration: number | undefined;
    let transactionRolledBack = false;
    let transactionCommitted = false;
    let pointerRestorationAttempted = false;

    const rollback = async (): Promise<void> => {
      let recoveryError: unknown;
      try {
        if (restore && !transactionRolledBack && !transactionCommitted) {
          transactionRolledBack = true;
          await restore.rollback();
        }
      } catch (error) {
        recoveryError = error;
      } finally {
        if (pointerChanged && pointerGeneration !== undefined && !pointerRestorationAttempted) {
          pointerRestorationAttempted = true;
          try {
            this.port.restoreVisibleState(previous, thread, pointerGeneration);
          } catch (error) {
            recoveryError = recoveryError
              ? new AggregateError([recoveryError, error], "Visible activation recovery failed")
              : error;
          }
        }
      }
      if (recoveryError) throw recoveryError;
    };

    try {
      if (!activation.isCurrent()) {
        await rollback();
        return false;
      }
      await this.port.adopt(thread);
      if (!this.port.isCurrentRuntime(thread)) throw new Error("The thread runtime was replaced before activation.");
      if (!activation.isCurrent()) {
        await rollback();
        return false;
      }
      pointerGeneration = ++this.visibleGeneration;
      this.port.setVisible(thread, pointerGeneration);
      pointerChanged = true;
      if (thread.backend.kind !== "machine") await this.port.rememberProject(thread.cwd);
      if (!activation.isCurrent()) {
        await rollback();
        return false;
      }
      await this.port.refreshShell(thread, touch);
      if (!activation.isCurrent()) {
        await rollback();
        return false;
      }
      this.port.publishVisible(thread);
      // Finish extension effects after publishing the selected runtime. A
      // later activation may supersede it, but cannot safely undo effects
      // that have already committed.
      if (restore) {
        await restore.commit();
        transactionCommitted = true;
      }
      return true;
    } catch (error) {
      try {
        await rollback();
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "Thread activation failed and workspace recovery needs attention.", { cause: recoveryError });
      }
      throw error;
    }
  }

}
