import { LifecycleQueue, type LifecycleQueueOptions } from "./lifecycle-queue.js";

export type HostActivationAdmission = "exclusive" | "unserialized";

/** A visible activation's immutable token; its liveness is read from the owner. */
export interface HostActivationLease {
  readonly epoch: number;
  isCurrent(): boolean;
}

/**
 * Shared lifecycle queue and activation token state. An operation can be
 * ordered correctly and still be stale by the time its awaited work returns.
 *
 * `run` is the exclusive lane used by visible lifecycle work and extension
 * hooks. `runBackground` is the bounded lane for work that builds a thread of
 * its own. `runActivation` is the visible operation boundary: it mints the
 * epoch before queue admission and passes the lease into the operation, so a
 * caller cannot accidentally queue first and invalidate second.
 */
export class HostLifecycleCoordinator {
  private readonly queue: LifecycleQueue;
  private activationEpoch = 0;

  constructor(options: LifecycleQueueOptions = {}) {
    this.queue = new LifecycleQueue(options);
  }

  get currentActivationEpoch(): number {
    return this.activationEpoch;
  }

  /** Invalidates every older visible activation and returns its token. */
  beginActivation(): number {
    this.activationEpoch += 1;
    return this.activationEpoch;
  }

  isCurrentActivation(epoch: number): boolean {
    return this.activationEpoch === epoch;
  }

  activation(epoch = this.activationEpoch): HostActivationLease {
    return { epoch, isCurrent: () => this.isCurrentActivation(epoch) };
  }

  runActivation<T>(
    name: string,
    operation: (activation: HostActivationLease) => Promise<T>,
    admission: HostActivationAdmission = "exclusive",
  ): Promise<T> {
    const activation = this.activation(this.beginActivation());
    const run = () => operation(activation);
    return admission === "unserialized" ? run() : this.queue.run(name, run);
  }

  run<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(name, operation);
  }

  runBackground<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.runBackground(name, operation);
  }

  get reentrant(): boolean {
    return this.queue.reentrant;
  }

  get currentOperation(): string | undefined {
    return this.queue.currentOperation;
  }
}
