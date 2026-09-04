import { HOST_ERROR, hostErrorInfo, type HostJobEvent } from "../shared/host-transport.js";

/** What a method may report while it runs; a plain request gets a no-op context. */
export interface HostMethodContext {
  progress(message: string, fraction?: number): void;
  /** Aborted when the client cancels the job. */
  readonly signal: AbortSignal;
}

export const NO_JOB_CONTEXT: HostMethodContext = { progress: () => undefined, signal: new AbortController().signal };

interface RunningJob {
  controller: AbortController;
  done: boolean;
}

/**
 * Runs long methods off the request/response path. Progress and the result
 * arrive as pushes, so a failure or a cancellation is a partial failure: the
 * connection stays up and every other request keeps working.
 */
export class HostJobRunner {
  private counter = 0;
  private readonly jobs = new Map<string, RunningJob>();

  constructor(private readonly publish: (event: HostJobEvent) => void) {}

  get activeCount(): number {
    return [...this.jobs.values()].filter((job) => !job.done).length;
  }

  start(run: (context: HostMethodContext) => Promise<unknown>): string {
    this.counter += 1;
    const jobId = `job-${this.counter}`;
    const job: RunningJob = { controller: new AbortController(), done: false };
    this.jobs.set(jobId, job);
    const context: HostMethodContext = {
      progress: (message, fraction) => {
        if (!job.done) this.publish({ type: "job-progress", jobId, message, ...(fraction === undefined ? {} : { fraction }) });
      },
      signal: job.controller.signal,
    };
    void (async () => {
      try {
        const result = await run(context);
        this.settle(jobId, { type: "job-done", jobId, result });
      } catch (error) {
        this.settle(jobId, { type: "job-done", jobId, error: hostErrorInfo(error) });
      }
    })();
    return jobId;
  }

  /** True when the job existed and was still running. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.done) return false;
    job.controller.abort();
    this.settle(jobId, { type: "job-done", jobId, error: { message: "Cancelled.", code: HOST_ERROR.cancelled } });
    return true;
  }

  private settle(jobId: string, event: HostJobEvent): void {
    const job = this.jobs.get(jobId);
    // A cancelled job already reported; the late result is dropped.
    if (!job || job.done) return;
    job.done = true;
    this.jobs.delete(jobId);
    this.publish(event);
  }
}
