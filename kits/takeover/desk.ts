import { randomUUID } from "node:crypto";
import { TAKEOVER_TIMEOUT_MS, isHeldTool, type Takeover, type TakeoverTarget } from "./protocol.js";

export type TakeoverOutcome = "done" | "cancelled" | "timeout" | "aborted" | "busy";

export interface TakeoverDeskPorts {
  /** Every client hears the whole list whenever it changes. */
  publish(takeovers: Takeover[]): void;
  pauseEvidence(threadId: string, reason: string): Promise<unknown>;
  resumeEvidence(threadId: string): Promise<unknown>;
  describe(threadId: string): { title?: string; sessionFile?: string };
  log(label: string, detail?: string): void;
  now(): number;
  timeoutMs?: number;
}

interface Pending {
  takeover: Takeover;
  settle(outcome: TakeoverOutcome): void;
}

/**
 * The requests that wait for the user, one per thread at most. While any
 * waits, the agents' Computer Use and Preview tools are held and Evidence
 * Kit takes no pictures of that thread or of the Preview.
 */
export class TakeoverDesk {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ports: TakeoverDeskPorts) {}

  list(): Takeover[] {
    return [...this.pending.values()].map((entry) => entry.takeover).sort((a, b) => a.since - b.since);
  }

  request(threadId: string, reason: string, target: TakeoverTarget, signal?: AbortSignal): Promise<TakeoverOutcome> {
    if ([...this.pending.values()].some((entry) => entry.takeover.threadId === threadId)) return Promise.resolve("busy");
    if (signal?.aborted) return Promise.resolve("aborted");
    const takeover: Takeover = { id: randomUUID(), threadId, reason, target, since: this.ports.now(), ...this.ports.describe(threadId) };
    return new Promise<TakeoverOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), this.ports.timeoutMs ?? TAKEOVER_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => settle("aborted");
      const settle = (outcome: TakeoverOutcome) => {
        if (this.pending.get(takeover.id)?.takeover !== takeover) return;
        this.pending.delete(takeover.id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.ports.log("takeover.ended", `${threadId}: ${outcome}`);
        this.ports.resumeEvidence(threadId).catch((error: unknown) => this.ports.log("takeover.resume-failed", String(error)));
        this.publish();
        resolve(outcome);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(takeover.id, { takeover, settle });
      this.ports.log("takeover.started", `${threadId}: ${target.kind}`);
      // Paused before any client can draw the button that leads to a password.
      this.ports.pauseEvidence(threadId, reason).catch((error: unknown) => this.ports.log("takeover.pause-failed", String(error)))
        .finally(() => { if (this.pending.has(takeover.id)) this.publish(); });
    });
  }

  finish(id: string, outcome: "done" | "cancelled"): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(outcome);
    return true;
  }

  /** The thread's runtime went away: nobody waits for an answer any more. */
  endThread(threadId: string): void {
    for (const entry of [...this.pending.values()]) if (entry.takeover.threadId === threadId) entry.settle("aborted");
  }

  /** Blocks what the user holds right now, from any thread and any runtime. */
  hold(toolName: string): { block: true; reason: string } | undefined {
    const [first] = this.list();
    if (!first || !isHeldTool(toolName)) return undefined;
    return { block: true, reason: `Blocked by Tau: the user has taken over (“${first.reason}”). Computer Use and the Preview are theirs until they are done; wait and do not retry now.` };
  }

  dispose(): void {
    for (const entry of [...this.pending.values()]) entry.settle("aborted");
  }

  private publish(): void {
    this.ports.publish(this.list());
  }
}
