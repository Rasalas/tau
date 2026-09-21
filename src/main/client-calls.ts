import { randomUUID } from "node:crypto";
import type { HostEvent } from "../shared/contracts.js";

/** A client half that never answers must not hold a tool call forever. */
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Calls that travel the other way: from the host to the process a client runs
 * in. A host extension whose work needs a window — a native view over the
 * panel, say — asks for it here, and the window's half answers with the
 * `client-call-result` method (ADR 0021).
 */
export class ClientCalls {
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly publish: (event: HostEvent) => void,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  call(extensionId: string, command: string, input?: unknown): Promise<unknown> {
    const callId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`No client answered ${extensionId}/${command} within ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(callId, { resolve, reject, timer });
      this.publish({ type: "client-call", callId, extensionId, command, ...(input === undefined ? {} : { input }) });
    });
  }

  /** The client's answer. An unknown id is ignored: it is a late or duplicate reply. */
  settle(callId: string, result: unknown, error?: string): void {
    const call = this.pending.get(callId);
    if (!call) return;
    this.pending.delete(callId);
    clearTimeout(call.timer);
    if (error) call.reject(new Error(error));
    else call.resolve(result);
  }

  /** Every waiting call fails at once; used when the host stops. */
  dispose(): void {
    for (const [callId] of this.pending) this.settle(callId, undefined, "The host stopped waiting for this client.");
  }
}
