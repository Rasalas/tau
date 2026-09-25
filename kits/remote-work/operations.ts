import { randomUUID } from "node:crypto";
import { HostCommandError } from "tau/host-extension";
import type { OperationSnapshot, TransferStep, TransferStepId, TransferStepState } from "./protocol.js";

/** How long a finished operation can still be read, for a sending side that was offline when it ended. */
const KEEP_MS = 60 * 60_000;

interface Operation {
  snapshot: OperationSnapshot;
  device?: string;
  endedAt?: number;
}

export interface OperationStep {
  (id: TransferStepId, state: TransferStepState, detail?: string): void;
}

/**
 * Work on the receiving side that outlasts one call (a clone, `npm ci`): a
 * call starts it and answers its id at once, the sending side follows its
 * snapshots by topic and asks for them, so neither a 30 s call timeout nor a
 * dropped connection cuts it short.
 */
export class Operations {
  private readonly operations = new Map<string, Operation>();

  constructor(private readonly options: { emit(snapshot: OperationSnapshot): void; now?: () => number; newId?: () => string }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sweep(): void {
    for (const [id, operation] of this.operations) {
      if (operation.endedAt !== undefined && this.now() - operation.endedAt > KEEP_MS) this.operations.delete(id);
    }
  }

  start<Result>(kind: OperationSnapshot["kind"], device: string | undefined, steps: TransferStep[], run: (step: OperationStep) => Promise<Result>): OperationSnapshot<Result> {
    this.sweep();
    const id = (this.options.newId ?? (() => randomUUID().replaceAll("-", "")))();
    const operation: Operation = { snapshot: { id, kind, state: "running", steps: steps.map((step) => ({ ...step })) }, ...(device ? { device } : {}) };
    this.operations.set(id, operation);
    const publish = () => this.options.emit(structuredClone(operation.snapshot));
    const step: OperationStep = (stepId, state, detail) => {
      const target = operation.snapshot.steps.find((candidate) => candidate.id === stepId);
      if (!target || operation.snapshot.state !== "running") return;
      target.state = state;
      if (detail === undefined) delete target.detail;
      else target.detail = detail;
      publish();
    };
    // Settles after this call answered, so the first snapshot never races the id.
    void Promise.resolve().then(() => run(step)).then((result) => {
      operation.snapshot = { ...operation.snapshot, state: "done", result };
    }, (error: unknown) => {
      const running = operation.snapshot.steps.find((candidate) => candidate.state === "running");
      if (running) running.state = "failed";
      operation.snapshot = { ...operation.snapshot, state: "failed", error: error instanceof Error ? error.message : String(error) };
    }).then(() => {
      operation.endedAt = this.now();
      publish();
    });
    return structuredClone(operation.snapshot) as OperationSnapshot<Result>;
  }

  /** The operation as it stands, for the device that started it (or this machine's owner). */
  get(id: string, device?: string): OperationSnapshot {
    this.sweep();
    const operation = this.operations.get(id);
    if (!operation || (operation.device && device && operation.device !== device)) throw new HostCommandError(`This machine has no operation ${id}; it ended over an hour ago or never started.`);
    return structuredClone(operation.snapshot);
  }
}
