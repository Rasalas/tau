import type { WorkbenchReloadMode, WorkbenchReloadPreparation } from "../shared/contracts.js";

interface ReloadRun {
  /** Resolves once the run is over; a runtime in another process is polled. */
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
}

export interface WorkbenchReloadCoordinatorOptions {
  /** Every thread with work in flight, whichever process runs it. */
  runs(): ReloadRun[];
  serialize<T>(operation: () => Promise<T>): Promise<T>;
}

/** Owns the drain-and-lock protocol used before replacing the workbench. */
export class WorkbenchReloadCoordinator {
  private pending = false;
  private aborting?: Promise<void>;

  constructor(private readonly options: WorkbenchReloadCoordinatorOptions) {}

  assertAvailable(): void {
    if (this.pending) throw new Error("Tau is waiting to apply changes. Cancel the reload before starting more work.");
  }

  private runningCount(): number {
    return this.options.runs().length;
  }

  private async waitForRuns(): Promise<void> {
    for (;;) {
      await Promise.all(this.options.runs().map((run) => run.waitForIdle()));
      const ready = await this.options.serialize(async () => {
        if (this.runningCount() > 0) return false;
        this.pending = true;
        return true;
      });
      if (ready) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  async prepare(mode: WorkbenchReloadMode): Promise<WorkbenchReloadPreparation> {
    if (mode === "wait") {
      await this.waitForRuns();
      return { ready: true, runningThreads: 0 };
    }
    const { preparation, aborting } = await this.options.serialize(async () => {
      const runningThreads = this.runningCount();
      if (this.pending) return {
        preparation: { ready: !this.aborting, runningThreads: this.aborting ? runningThreads : 0 },
        aborting: this.aborting,
      };
      if (mode === "inspect") {
        if (runningThreads === 0) this.pending = true;
        return { preparation: { ready: runningThreads === 0, runningThreads }, aborting: undefined };
      }
      if (mode !== "abort") throw new Error(`Unknown workbench reload mode: ${mode}`);
      this.pending = true;
      this.aborting = Promise.all(this.options.runs().map((run) => run.abort())).then(() => undefined);
      return { preparation: { ready: true, runningThreads: 0 }, aborting: this.aborting };
    });
    if (mode === "abort") {
      try { await aborting; } catch (error) { this.release(); throw error; }
      if (this.aborting === aborting) this.aborting = undefined;
      return { ready: true, runningThreads: 0 };
    }
    return preparation;
  }

  release(): void { this.pending = false; this.aborting = undefined; }
}
